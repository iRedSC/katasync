import { and, eq, inArray } from "drizzle-orm";
import {
	ingestShopifyOrder,
	shopifyCancelFulfillment,
	shopifyFulfill,
} from "#/channels/shopify";
import { pickupOpen, shopifyReadyForPickup } from "#/channels/shopify/pickup";
import type { Db } from "#/db/client";
import { orderLines, orders, stores } from "#/db/schema";
import { consumeCommitments } from "#/inventory/commitments-consume";
import {
	assertFulfillmentRestorable,
	restoreCommitments,
} from "#/inventory/commitments-restore";
import { awaitsPickup, financialStatus } from "#/orders/to-ship";
import { lockOnOwnConnection, type OrderLocker } from "./dispatch";

// A local pickup goes through two steps, both told to Shopify: ready (set
// aside; Shopify emails the buyer to come) and picked up (fulfilled with no
// tracking). It's never packed or labeled (to-ship.ts's needsPacking).

export type PickupOutside = {
	lock: OrderLocker;
	ready: typeof shopifyReadyForPickup;
	open: typeof pickupOpen;
	fulfill: typeof shopifyFulfill;
	unfulfill: typeof shopifyCancelFulfillment;
	// Reads the order back, so its stock settles the way any Shopify
	// fulfillment's does.
	reread: (db: Db, orderId: string) => Promise<unknown>;
};

const live: PickupOutside = {
	lock: lockOnOwnConnection,
	ready: shopifyReadyForPickup,
	open: pickupOpen,
	fulfill: shopifyFulfill,
	unfulfill: shopifyCancelFulfillment,
	reread: ingestShopifyOrder,
};

async function pickupOrder(db: Db, orderId: number) {
	const [order] = await db
		.select({
			name: orders.name,
			externalId: orders.externalId,
			channel: stores.channel,
			cancelledAt: orders.cancelledAt,
			financialStatus,
			readyForPickupAt: orders.readyForPickupAt,
			pickup: orders.pickup,
			awaitsPickup,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(eq(orders.id, orderId));
	if (!order) throw new Error(`No order ${orderId}`);
	if (!order.pickup || order.channel !== "shopify")
		throw new Error(`${order.name} isn't a pickup`);
	if (order.cancelledAt) throw new Error(`${order.name} was cancelled`);
	if (
		order.financialStatus === "REFUNDED" ||
		order.financialStatus === "VOIDED"
	)
		throw new Error(`${order.name} was refunded`);
	if (!order.awaitsPickup)
		throw new Error(`${order.name} was already picked up`);
	return order;
}

// Shopify emails the buyer that it's ready. Repeating it is harmless to
// refuse, so a second press says so instead of emailing again.
export async function markReadyForPickup(
	db: Db,
	orderId: number,
	outside: PickupOutside = live,
): Promise<{ name: string; readyAt: Date }> {
	return outside.lock([orderId], async () => {
		const order = await pickupOrder(db, orderId);
		if (order.readyForPickupAt)
			throw new Error(`${order.name} is already ready for pickup`);
		await outside.ready(order.externalId);
		const readyAt = new Date();
		await db
			.update(orders)
			.set({ readyForPickupAt: readyAt })
			.where(eq(orders.id, orderId));
		return { name: order.name, readyAt };
	});
}

// The buyer has it: Shopify fulfills everything open, with no tracking, and
// the order leaves To ship at once. Its units leave the shelf now, as a
// shipped box's do at handoff, under the fulfillment's own key. Ready isn't
// required first, for a buyer who walks in before the email goes.
export async function markPickedUp(
	db: Db,
	orderId: number,
	outside: PickupOutside = live,
): Promise<{ name: string; problems: string[] }> {
	return outside.lock([orderId], async () => {
		const order = await pickupOrder(db, orderId);
		const { units } = await outside.open(order.externalId);
		if (units.size === 0)
			throw new Error(
				`Shopify shows nothing of ${order.name} left to hand over; it may be on hold there`,
			);
		const delivered = await outside.fulfill(
			order.externalId,
			null,
			units,
			"exactly",
		);
		// Recorded first and on its own: Shopify has it now, whatever the
		// stock says next, and Undo needs to know which fulfillment it was.
		await db
			.update(orders)
			.set({
				pickupFulfillmentId: delivered.fulfillmentId,
				fulfillmentStatus:
					delivered.remaining > 0 ? "PARTIALLY_FULFILLED" : "FULFILLED",
			})
			.where(eq(orders.id, orderId));
		const lines = await db
			.select({ id: orderLines.id, externalId: orderLines.externalId })
			.from(orderLines)
			.where(
				and(
					eq(orderLines.orderId, orderId),
					inArray(orderLines.externalId, [...units.keys()]),
				),
			);
		const problems: string[] = [];
		await consumeCommitments(db, {
			orderId,
			lines: lines.map((l) => ({
				orderLineId: l.id,
				quantity: units.get(l.externalId) ?? 0,
			})),
			fulfillmentKey: pickupKey(delivered.fulfillmentId),
		}).catch((error: unknown) => {
			problems.push(`${order.name}'s stock didn't move: ${errorText(error)}`);
		});
		problems.push(...(await reread(db, order, outside)));
		return { name: order.name, problems };
	});
}

// Takes back the last picked up: its Shopify fulfillment is cancelled and
// its units are held on the shelf again, so the order waits for pickup.
// Only that fulfillment, the one katasync recorded, can be cancelled.
export async function undoPickedUp(
	db: Db,
	orderId: number,
	outside: PickupOutside = live,
): Promise<{ name: string; problems: string[] }> {
	return outside.lock([orderId], async () => {
		const [order] = await db
			.select({
				name: orders.name,
				externalId: orders.externalId,
				fulfillmentId: orders.pickupFulfillmentId,
			})
			.from(orders)
			.where(eq(orders.id, orderId));
		if (!order) throw new Error(`No order ${orderId}`);
		if (!order.fulfillmentId)
			throw new Error(`${order.name} has no pickup to take back`);
		const key = pickupKey(order.fulfillmentId);
		// Refused before Shopify hears, e.g. once a return was received.
		await assertFulfillmentRestorable(db, { orderId, fulfillmentKey: key });
		await outside.unfulfill(order.fulfillmentId);
		await db.transaction(async (tx) => {
			await restoreCommitments(tx, { orderId, fulfillmentKey: key });
			await tx
				.update(orders)
				.set({ pickupFulfillmentId: null })
				.where(eq(orders.id, orderId));
		});
		return { name: order.name, problems: await reread(db, order, outside) };
	});
}

const pickupKey = (fulfillmentId: string) => `pickup:${fulfillmentId}`;

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// Shopify has the change; a failed read back only delays the order's
// status until the next sync, which reads it the same way.
const reread = (
	db: Db,
	order: { name: string; externalId: string },
	outside: PickupOutside,
): Promise<string[]> =>
	outside
		.reread(db, order.externalId)
		.then(() => [])
		.catch((error: unknown) => [
			`${order.name} shows its old status until the next sync (${errorText(error)})`,
		]);
