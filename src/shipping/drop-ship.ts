import { eq } from "drizzle-orm";
import { shopifyFulfill } from "#/channels/shopify";
import { stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import { orderLines, orders, stores } from "#/db/schema";
import { readQuantityMode } from "#/inventory/commitments";
import { isUndone, undoBatch } from "#/inventory/ledger";
import { batchProductIds, lockRecipes } from "#/inventory/ledger/post";
import {
	cleanTracking,
	type DropShipCarrier,
	dropShipTarget,
} from "#/orders/drop-ship";
import { orderTakesStock } from "#/orders/ingest";
import { commitmentProductIds, syncLineStock } from "#/orders/stock-effects";
import { financialStatus, needsPacking, needsShipping } from "#/orders/to-ship";
import {
	liveDispatches,
	lockOnOwnConnection,
	type OrderLocker,
} from "./dispatch";
import { ebayShip } from "./ebay-handoff";
import { assignOrderPins } from "./pins";

// A drop-ship goes from a supplier's stock straight to the buyer. Marking an
// order one gives its stock back and takes its pin, so it can't be packed
// (dispatch_orders refuses it too, drizzle/0179). It stays on To ship until
// the supplier's tracking is sent to the marketplace, or the marketplace
// shows it shipped. Unmarking puts it back to be packed and takes its stock
// again. The pure rules are in src/orders/drop-ship.ts.

export type DropShipOutside = {
	lock: OrderLocker;
	shopifyFulfill: typeof shopifyFulfill;
	ebayShip: typeof ebayShip;
};

const live: DropShipOutside = {
	lock: lockOnOwnConnection,
	shopifyFulfill,
	ebayShip,
};

// Marks an order drop-shipped. Under the same lock as buying a label, so a
// label can't be bought for it at the same moment. Refused while it has a
// label (void it first), once it's no longer ours to pack, and in committed
// stock for a line that took stock before activation, which only a count
// or return can settle.
export async function markDropShip(
	db: Db,
	orderId: number,
	outside: DropShipOutside = live,
): Promise<{ name: string }> {
	const name = await outside.lock([orderId], () =>
		db.transaction(async (tx) => {
			const mode = await readQuantityMode(tx);
			const [order] = await tx
				.select({
					name: orders.name,
					dropShipAt: orders.dropShipAt,
					fulfilledByChannel: orders.fulfilledByChannel,
					soldInStore: orders.soldInStore,
					fulfillmentStatus: orders.fulfillmentStatus,
					needsPacking,
				})
				.from(orders)
				.where(eq(orders.id, orderId))
				.for("update");
			if (!order) throw new Error(`No order ${orderId}`);
			if (order.dropShipAt)
				throw new Error(`${order.name} is already a drop-ship`);
			if (order.fulfilledByChannel || order.soldInStore || !order.needsPacking)
				throw new Error(`${order.name} isn't waiting to be packed`);
			// Part of it went out already, from our shelf: giving the whole
			// sale back would count that part twice.
			if (order.fulfillmentStatus === "PARTIALLY_FULFILLED")
				throw new Error(
					`${order.name} is partly shipped, so only all of it can be a drop-ship`,
				);
			if ((await liveDispatches(tx, [orderId])).length > 0)
				throw new Error(
					`${order.name} has a label. Void it on the order page first.`,
				);

			const lines = await tx
				.select()
				.from(orderLines)
				.where(eq(orderLines.orderId, orderId))
				.orderBy(orderLines.id)
				.for("update");
			const batches = lines.flatMap((l) =>
				l.saleBatchId ? [l.saleBatchId] : [],
			);
			if (mode === "committed" && batches.length > 0)
				throw new Error(
					`${order.name} took stock before committed stock, so it can't be a drop-ship`,
				);
			await lockRecipes(
				tx,
				lines.flatMap((l) => (l.productId === null ? [] : [l.productId])),
				[
					...(await batchProductIds(tx, batches)),
					...(await commitmentProductIds(
						tx,
						lines.map((l) => l.id),
					)),
				],
			);
			// Saved first, so stock rules read from here on see a drop-ship.
			await tx
				.update(orders)
				.set({ dropShipAt: new Date(), pin: null })
				.where(eq(orders.id, orderId));
			const from = await stockLocations(tx);
			for (const line of lines) {
				if (line.saleBatchId) {
					if (!(await isUndone(tx, line.saleBatchId)))
						await undoBatch(tx, line.saleBatchId);
					await tx
						.update(orderLines)
						.set({ saleBatchId: null })
						.where(eq(orderLines.id, line.id));
				}
				// Committed stock: lets go of what the line reserved.
				const problem = await syncLineStock(tx, {
					row: line,
					sku: line.sku,
					order: { name: order.name, soldInStore: false },
					takesStock: false,
					from,
				});
				if (problem) throw new Error(problem);
			}
			return order.name;
		}),
	);
	return { name };
}

// Puts a drop-ship back to be packed here: it takes its stock again and gets
// a pin. Refused once its tracking went out or the marketplace shows it
// shipped, since then the supplier's box is on its way. A line whose stock
// can't be taken now is left for the next sync, as a new order's would be.
export async function unmarkDropShip(
	db: Db,
	orderId: number,
	outside: Pick<DropShipOutside, "lock"> = live,
): Promise<{ name: string; problems: string[] }> {
	const result = await outside.lock([orderId], () =>
		db.transaction(async (tx) => {
			await readQuantityMode(tx);
			const [order] = await tx
				.select({
					name: orders.name,
					dropShipAt: orders.dropShipAt,
					dropShipSentAt: orders.dropShipSentAt,
					placedAt: orders.placedAt,
					cancelledAt: orders.cancelledAt,
					fulfilledByChannel: orders.fulfilledByChannel,
					soldInStore: orders.soldInStore,
					storeId: orders.storeId,
					stockFrom: stores.stockFrom,
					needsShipping,
				})
				.from(orders)
				.innerJoin(stores, eq(stores.id, orders.storeId))
				.where(eq(orders.id, orderId))
				.for("update", { of: orders });
			if (!order) throw new Error(`No order ${orderId}`);
			if (!order.dropShipAt) throw new Error(`${order.name} isn't a drop-ship`);
			if (order.dropShipSentAt || !order.needsShipping)
				throw new Error(`${order.name} already shipped from the supplier`);
			await tx
				.update(orders)
				.set({ dropShipAt: null })
				.where(eq(orders.id, orderId));
			const takesStock = orderTakesStock(
				{ id: order.storeId, stockFrom: order.stockFrom },
				order,
			);
			const lines = await tx
				.select()
				.from(orderLines)
				.where(eq(orderLines.orderId, orderId))
				.orderBy(orderLines.id)
				.for("update");
			await lockRecipes(
				tx,
				lines.flatMap((l) => (l.productId === null ? [] : [l.productId])),
				await commitmentProductIds(
					tx,
					lines.map((l) => l.id),
				),
			);
			const from = await stockLocations(tx);
			const problems: string[] = [];
			for (const line of lines) {
				if (line.saleBatchId) continue;
				const problem = await syncLineStock(tx, {
					row: line,
					sku: line.sku,
					order: { name: order.name, soldInStore: order.soldInStore },
					takesStock,
					from,
				});
				if (problem) problems.push(problem);
			}
			return { name: order.name, problems };
		}),
	);
	await assignOrderPins(db);
	return result;
}

export type SupplierTracking = { carrier: DropShipCarrier; number: string };

// Tells the marketplace a drop-ship shipped, with the supplier's tracking or
// none at all, and the marketplace emails the buyer. Every line goes in it,
// at its quantity now: the marketplace must still show exactly that open,
// or nothing is sent (see shopifyFulfill and ebayShip). Recorded right after,
// so the order leaves To ship at once.
export async function sendDropShipTracking(
	db: Db,
	orderId: number,
	tracking: SupplierTracking | null,
	outside: DropShipOutside = live,
): Promise<{ name: string; message: string }> {
	const number = tracking ? cleanTracking(tracking.number) : null;
	if (number === "") throw new Error("No tracking number");
	return outside.lock([orderId], async () => {
		const [order] = await db
			.select({
				name: orders.name,
				externalId: orders.externalId,
				marketplaceOrderId: orders.marketplaceOrderId,
				salesChannel: orders.salesChannel,
				shipCountry: orders.shipCountry,
				channel: stores.channel,
				cancelledAt: orders.cancelledAt,
				financialStatus,
				dropShipAt: orders.dropShipAt,
				dropShipSentAt: orders.dropShipSentAt,
				needsShipping,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(eq(orders.id, orderId));
		if (!order) throw new Error(`No order ${orderId}`);
		if (!order.dropShipAt) throw new Error(`${order.name} isn't a drop-ship`);
		if (order.dropShipSentAt)
			return { name: order.name, message: `${order.name} was already sent` };
		if (order.cancelledAt) throw new Error(`${order.name} was cancelled`);
		if (
			order.financialStatus === "REFUNDED" ||
			order.financialStatus === "VOIDED"
		)
			throw new Error(`${order.name} was refunded`);
		if (!order.needsShipping)
			throw new Error(`${order.name} already shows as shipped`);
		const target = dropShipTarget(order);
		if (target.kind === "elsewhere")
			throw new Error(`Add ${order.name}'s tracking on ${target.name}`);

		const lines = await db
			.select({
				externalId: orderLines.externalId,
				quantity: orderLines.quantity,
			})
			.from(orderLines)
			.where(eq(orderLines.orderId, orderId));
		const packed = new Map(
			lines.flatMap((l) =>
				l.quantity > 0 ? [[l.externalId, l.quantity] as const] : [],
			),
		);
		if (packed.size === 0) throw new Error(`${order.name} has nothing to ship`);

		const channel = target.channel;
		// Claimed before the marketplace hears, so once it may have, nothing
		// can put the order back to be packed (unmarkDropShip refuses a sent
		// one). A refusal lets go of the claim. A request lost on the network
		// (fetch's TypeError, an abort) may have got through, so it keeps the
		// claim: the safe side, settled by the next sync.
		await db
			.update(orders)
			.set({ dropShipSentAt: new Date() })
			.where(eq(orders.id, orderId));
		const delivered = await tellMarketplace().catch(async (error: unknown) => {
			const lost =
				error instanceof TypeError ||
				(error instanceof Error && error.name === "AbortError");
			if (!lost)
				await db
					.update(orders)
					.set({ dropShipSentAt: null })
					.where(eq(orders.id, orderId));
			throw error;
		});
		async function tellMarketplace() {
			return channel === "shopify"
				? await outside.shopifyFulfill(
						order.externalId,
						tracking && number
							? {
									company: tracking.carrier,
									// No url: Shopify links its known carriers itself.
									boxes: [{ number, url: null }],
								}
							: null,
						packed,
					)
				: await outside.ebayShip(
						order.externalId,
						packed,
						tracking && number
							? {
									carrier: tracking.carrier,
									trackingNumber: number,
									shippedAt: new Date(),
								}
							: { carrier: null, trackingNumber: null, shippedAt: new Date() },
					);
		}
		await db
			.update(orders)
			.set({
				dropShipCarrier: tracking && number ? tracking.carrier : null,
				dropShipTracking: number,
				fulfillmentStatus:
					delivered.remaining > 0 ? "PARTIALLY_FULFILLED" : "FULFILLED",
			})
			.where(eq(orders.id, orderId));
		return {
			name: order.name,
			message: `${target.name} told it shipped; the customer is emailed`,
		};
	});
}
