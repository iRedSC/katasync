import { eq, sql } from "drizzle-orm";
import { ebayFulfill } from "#/channels/ebay";
import { shopifyCancelFulfillment, shopifyFulfill } from "#/channels/shopify";
import type { Db } from "#/db/client";
import { orderLines, orders, shipments, stores } from "#/db/schema";
import { assignOrderPins } from "./pins";
import { refundLabel } from "./shippo";

// The outside calls, passed in so tests can stand in for Shopify, eBay, and
// Shippo.
export type Outside = {
	shopifyFulfill: typeof shopifyFulfill;
	shopifyCancel: typeof shopifyCancelFulfillment;
	ebayFulfill: typeof ebayFulfill;
	refund: typeof refundLabel;
};

export const live: Outside = {
	shopifyFulfill,
	shopifyCancel: shopifyCancelFulfillment,
	ebayFulfill,
	refund: refundLabel,
};

// The channels katasync sends tracking to, by the name people use.
const trackingChannels: Record<string, string> = {
	shopify: "Shopify",
	ebay: "eBay",
};

async function load(db: Db, shipmentId: number) {
	const [row] = await db
		.select({
			shipment: shipments,
			order: {
				id: orders.id,
				externalId: orders.externalId,
				fulfillmentStatus: orders.fulfillmentStatus,
			},
			channel: stores.channel,
		})
		.from(shipments)
		.innerJoin(orders, eq(orders.id, shipments.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(eq(shipments.id, shipmentId));
	if (!row) throw new Error(`No shipment ${shipmentId}`);
	return row;
}

// Buying, sending, and voiding a label take turns per order, holding the
// lock across the outside call, so a double click or two people can't buy
// twice, refund twice, or send tracking for a label being voided. A crash
// mid-way rolls back with the transaction.
export async function withOrderLock<T>(
	db: Db,
	orderId: number,
	work: (tx: Db) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext('order-labels'), ${orderId})`,
		);
		return work(tx);
	});
}

async function orderOf(db: Db, shipmentId: number) {
	const [row] = await db
		.select({ orderId: shipments.orderId })
		.from(shipments)
		.where(eq(shipments.id, shipmentId));
	if (!row) throw new Error(`No shipment ${shipmentId}`);
	return row.orderId;
}

export type Handoff = { sent: boolean; message: string };

// Tells the order's marketplace it shipped, with tracking, so the customer
// hears about it and the order leaves To ship. A refusal is recorded on the
// shipment and shown with a retry; it never undoes the label. Retrying is
// safe: the marketplace calls return the earlier fulfillment if one got
// through.
export async function sendTracking(
	db: Db,
	shipmentId: number,
	outside: Outside = live,
): Promise<Handoff> {
	const result = await withOrderLock(
		db,
		await orderOf(db, shipmentId),
		async (tx) => {
			const { shipment, order, channel } = await load(tx, shipmentId);
			const name = trackingChannels[channel] ?? channel;
			if (shipment.voidedAt) throw new Error("This label was voided");
			if (shipment.channelSentAt) {
				return { sent: true, message: `Tracking already sent to ${name}` };
			}
			// A test label's tracking number is fake; customers must never get it.
			if (shipment.test) {
				return { sent: false, message: `Test label, so ${name} wasn't told` };
			}
			if (!(channel in trackingChannels)) {
				return {
					sent: false,
					message: `${name} orders are shipped on ${name}`,
				};
			}

			let fulfillmentId: string | null;
			try {
				if (!shipment.trackingNumber) {
					throw new Error("The label has no tracking number");
				}
				if (channel === "shopify") {
					fulfillmentId = await outside.shopifyFulfill(order.externalId, {
						company: shipment.carrier,
						number: shipment.trackingNumber,
						url: shipment.trackingUrl,
					});
				} else {
					const lines = await tx
						.select({
							lineItemId: orderLines.externalId,
							quantity: orderLines.quantity,
						})
						.from(orderLines)
						.where(eq(orderLines.orderId, order.id));
					fulfillmentId = await outside.ebayFulfill(order.externalId, {
						lineItems: lines,
						carrier: shipment.carrier,
						trackingNumber: shipment.trackingNumber,
						shippedAt: shipment.createdAt,
					});
				}
			} catch (err) {
				const why = err instanceof Error ? err.message : String(err);
				await tx
					.update(shipments)
					.set({ channelError: why })
					.where(eq(shipments.id, shipment.id));
				return {
					sent: false,
					message: `Tracking didn't reach ${name}: ${why}`,
				};
			}
			await tx
				.update(shipments)
				.set({
					channelSentAt: new Date(),
					channelFulfillmentId: fulfillmentId,
					channelError: null,
				})
				.where(eq(shipments.id, shipment.id));
			// Shipped now, not on the next sync: off To ship.
			await tx
				.update(orders)
				.set({ fulfillmentStatus: "FULFILLED" })
				.where(eq(orders.id, order.id));
			return {
				sent: true,
				message: `Tracking sent to ${name}; the customer is emailed`,
			};
		},
	);
	// Frees the shipped order's pin (or none, if nothing changed).
	if (result.sent) await assignOrderPins(db);
	return result;
}

export type Voided = { refundStatus: string; notes: string[] };

// Voids a label: asks for the postage back, takes the tracking back off the
// marketplace where it can, and returns the order to To ship. A refused
// refund changes nothing, so the label still counts.
export async function voidShipment(
	db: Db,
	shipmentId: number,
	outside: Outside = live,
): Promise<Voided> {
	const result = await withOrderLock(
		db,
		await orderOf(db, shipmentId),
		async (tx) => {
			const { shipment, order, channel } = await load(tx, shipmentId);
			if (shipment.voidedAt) throw new Error("This label is already voided");

			const { status: refundStatus } = await outside.refund(
				shipment.externalId,
			);
			await tx
				.update(shipments)
				.set({ voidedAt: new Date(), refundStatus })
				.where(eq(shipments.id, shipmentId));

			const notes: string[] = [];
			// Whether the marketplace now agrees the order isn't shipped.
			let backToShip = !shipment.channelSentAt;
			if (shipment.channelSentAt && channel === "shopify") {
				try {
					if (!shipment.channelFulfillmentId) {
						throw new Error("no fulfillment id saved");
					}
					await outside.shopifyCancel(shipment.channelFulfillmentId);
					notes.push("Shopify shows the order unshipped again");
					backToShip = true;
				} catch (err) {
					const why = err instanceof Error ? err.message : String(err);
					notes.push(
						`Shopify still shows it shipped (${why}). Cancel the fulfillment in Shopify.`,
					);
				}
			}
			if (shipment.channelSentAt && channel === "ebay") {
				notes.push(
					"eBay keeps the old tracking number; it can't be removed from here. Correct it in Seller Hub if this order isn't reshipped.",
				);
				backToShip = true;
			}
			// One live label per order, so voiding it means nothing has shipped.
			if (backToShip && order.fulfillmentStatus === "FULFILLED") {
				await tx
					.update(orders)
					.set({ fulfillmentStatus: "UNFULFILLED" })
					.where(eq(orders.id, order.id));
				notes.push("The order is back on To ship");
			}
			return { refundStatus, notes };
		},
	);
	await assignOrderPins(db);
	return result;
}
