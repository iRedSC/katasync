import { eq, sql } from "drizzle-orm";
import { ebayFulfill } from "#/channels/ebay";
import {
	shopifyCancelFulfillment,
	shopifyFulfill,
	shopifyRemoveShippoTracking,
	shopifySaveShippoTracking,
} from "#/channels/shopify";
import type { Db } from "#/db/client";
import { orderLines, orders, shipments, stores } from "#/db/schema";
import { assignOrderPins } from "./pins";
import { refundLabel } from "./shippo";
import { tiktokShipPackage } from "./tiktok";
import { storefrontTrackingUrl } from "./tracking-link";

// The outside calls, passed in so tests can stand in for Shopify, eBay, and
// Shippo.
export type Outside = {
	shopifyFulfill: typeof shopifyFulfill;
	shopifyCancel: typeof shopifyCancelFulfillment;
	shopifySaveTracking: typeof shopifySaveShippoTracking;
	shopifyRemoveTracking: typeof shopifyRemoveShippoTracking;
	ebayFulfill: typeof ebayFulfill;
	refund: typeof refundLabel;
	tiktokShip: typeof tiktokShipPackage;
};

export const live: Outside = {
	shopifyFulfill,
	shopifyCancel: shopifyCancelFulfillment,
	shopifySaveTracking: shopifySaveShippoTracking,
	shopifyRemoveTracking: shopifyRemoveShippoTracking,
	ebayFulfill,
	refund: refundLabel,
	tiktokShip: tiktokShipPackage,
};

// The channels katasync sends tracking to, by the name people use.
const trackingChannels: Record<string, string> = {
	shopify: "Shopify",
	ebay: "eBay",
	tiktok: "TikTok",
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

// Logs a failed katasync.shippo_tracking write loudly and returns the note
// shown on the shipment.
function storefrontNote(orderId: string, fix: string, err: unknown) {
	const why = err instanceof Error ? err.message : String(err);
	console.error(
		`STOREFRONT TRACKING NOT UPDATED for ${orderId}: ${fix} katasync.shippo_tracking.`,
		err,
	);
	return `The storefront's tracking page isn't up to date (${why}). ${fix} the order's katasync.shippo_tracking metafield in Shopify.`;
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
			// A TikTok label is TikTok's own; what's left is telling TikTok the
			// box is ready for pickup.
			const to = shipment.provider === "tiktok" ? "tiktok" : channel;
			const name = trackingChannels[to] ?? to;
			if (shipment.voidedAt) throw new Error("This label was voided");
			if (shipment.channelSentAt) {
				return { sent: true, message: `Tracking already sent to ${name}` };
			}
			// A test label's tracking number is fake; customers must never get it.
			if (shipment.test) {
				return { sent: false, message: `Test label, so ${name} wasn't told` };
			}
			if (!(to in trackingChannels)) {
				return {
					sent: false,
					message: `${name} orders are shipped on ${name}`,
				};
			}

			let fulfillmentId: string | null;
			try {
				if (to === "tiktok") {
					// TikTok has its own label's tracking already; katasync just
					// records it.
					const shipped = await outside.tiktokShip(shipment.externalId);
					fulfillmentId = shipped.id;
					if (shipped.trackingNumber && !shipment.trackingNumber) {
						await tx
							.update(shipments)
							.set({ trackingNumber: shipped.trackingNumber })
							.where(eq(shipments.id, shipment.id));
					}
				} else if (!shipment.trackingNumber) {
					throw new Error("The label has no tracking number");
				} else if (channel === "shopify") {
					fulfillmentId = await outside.shopifyFulfill(order.externalId, {
						company: shipment.carrier,
						number: shipment.trackingNumber,
						// The email's tracking link: the storefront's page, which
						// has the carrier's link too.
						url:
							(await storefrontTrackingUrl(order.externalId)) ??
							shipment.trackingUrl,
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
				message:
					to === "tiktok"
						? "Ready for pickup on TikTok; TikTok tells the customer"
						: `Tracking sent to ${name}; the customer is emailed`,
			};
		},
	);
	// Frees the shipped order's pin (or none, if nothing changed).
	if (result.sent) await assignOrderPins(db);
	// Only once shipped is committed: a slow or failed write can't hold up
	// or undo it.
	if (result.sent) {
		const note = await updateStorefrontTracking(db, shipmentId, outside);
		if (note) return { ...result, message: `${result.message}. ${note}` };
	}
	return result;
}

// Brings the storefront's katasync.shippo_tracking entry for a Shopify
// Shippo label in line with the label: listed while live, gone once voided.
// Best-effort and run after the send or void has committed: the customer
// was emailed either way, so a failure (Shopify calls give up after 5s) is
// only kept on the shipment, shown on the order and Diagnostics, for a fix
// by hand. Takes the order's lock so it can't interleave with a void.
// Returns the note, or null when the storefront is up to date.
async function updateStorefrontTracking(
	db: Db,
	shipmentId: number,
	outside: Outside,
): Promise<string | null> {
	return withOrderLock(db, await orderOf(db, shipmentId), async (tx) => {
		const { shipment, order, channel } = await load(tx, shipmentId);
		if (
			channel !== "shopify" ||
			!shipment.carrierToken ||
			!shipment.trackingNumber ||
			shipment.test
		) {
			return null;
		}
		const entry = {
			number: shipment.trackingNumber,
			carrier: shipment.carrierToken,
			url: shipment.trackingUrl,
		};
		let note: string | null = null;
		try {
			if (shipment.voidedAt) {
				await outside.shopifyRemoveTracking(order.externalId, entry.number);
			} else {
				await outside.shopifySaveTracking(order.externalId, entry);
			}
		} catch (err) {
			note = storefrontNote(
				order.externalId,
				shipment.voidedAt
					? `Remove tracking ${entry.number} from`
					: `Add ${JSON.stringify(entry)} to`,
				err,
			);
		}
		await tx
			.update(shipments)
			.set({ storefrontTrackingError: note })
			.where(eq(shipments.id, shipmentId));
		return note;
	});
}

// Tries the storefront's katasync.shippo_tracking entry again after a
// failure: saved for a shipped label, removed for a voided one. Clears the
// note when Shopify has it right, including after a fix by hand.
export async function retryStorefrontTracking(
	db: Db,
	shipmentId: number,
	outside: Outside = live,
): Promise<Handoff> {
	const { shipment } = await load(db, shipmentId);
	if (!shipment.carrierToken || !shipment.trackingNumber) {
		throw new Error("This label has nothing for the storefront");
	}
	const note = await updateStorefrontTracking(db, shipmentId, outside);
	if (note) return { sent: false, message: note };
	return {
		sent: true,
		message: shipment.voidedAt
			? "The storefront no longer lists this label"
			: "The storefront's tracking page has this label",
	};
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
			if (shipment.provider === "tiktok") {
				throw new Error(
					"TikTok labels can't be voided from katasync; cancel it in TikTok Seller Center",
				);
			}

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
	// After the void commits. Checked even if sending looked failed: the
	// entry may have been saved before an error.
	const note = await updateStorefrontTracking(db, shipmentId, outside);
	if (note) result.notes.push(note);
	return result;
}
