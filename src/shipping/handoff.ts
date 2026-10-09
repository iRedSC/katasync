import { and, eq, isNull, ne } from "drizzle-orm";
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

const channelNames: Record<string, string> = {
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

export type Handoff = { sent: boolean; message: string };

// Tells the order's marketplace it shipped, with tracking, so the customer
// hears about it and the order leaves To ship. A failure is recorded on the
// shipment and shown with a retry; it never undoes the label.
export async function sendTracking(
	db: Db,
	shipmentId: number,
	outside: Outside = live,
): Promise<Handoff> {
	const { shipment, order, channel } = await load(db, shipmentId);
	const name = channelNames[channel] ?? channel;
	if (shipment.voidedAt) throw new Error("This label was voided");
	if (shipment.channelSentAt) {
		return { sent: true, message: `Tracking already sent to ${name}` };
	}
	// A test label's tracking number is fake; customers must never get it.
	if (shipment.test) {
		return { sent: false, message: `Test label, so ${name} wasn't told` };
	}
	if (!(channel in channelNames)) {
		return { sent: false, message: `${name} orders are shipped on ${name}` };
	}

	try {
		if (!shipment.trackingNumber)
			throw new Error("The label has no tracking number");
		let fulfillmentId: string | null;
		if (channel === "shopify") {
			fulfillmentId = await outside.shopifyFulfill(order.externalId, {
				company: shipment.carrier,
				number: shipment.trackingNumber,
				url: shipment.trackingUrl,
			});
		} else {
			const lines = await db
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
		await db.transaction(async (tx) => {
			await tx
				.update(shipments)
				.set({
					channelSentAt: new Date(),
					channelFulfillmentId: fulfillmentId,
					channelError: null,
				})
				.where(eq(shipments.id, shipment.id));
			// Shipped now, not on the next sync: off To ship and its pin freed.
			await tx
				.update(orders)
				.set({ fulfillmentStatus: "FULFILLED" })
				.where(eq(orders.id, order.id));
		});
		await assignOrderPins(db);
		return {
			sent: true,
			message: `Tracking sent to ${name}; the customer is emailed`,
		};
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		await db
			.update(shipments)
			.set({ channelError: why })
			.where(eq(shipments.id, shipment.id));
		return { sent: false, message: `Tracking didn't reach ${name}: ${why}` };
	}
}

export type Voided = { refundStatus: string; notes: string[] };

// Voids a label: asks for the postage back, takes the tracking back off the
// marketplace where it can, and returns the order to To ship. Claimed first,
// so two clicks can't refund twice.
export async function voidShipment(
	db: Db,
	shipmentId: number,
	outside: Outside = live,
): Promise<Voided> {
	const [claimed] = await db
		.update(shipments)
		.set({ voidedAt: new Date() })
		.where(and(eq(shipments.id, shipmentId), isNull(shipments.voidedAt)))
		.returning({ id: shipments.id });
	if (!claimed) throw new Error("This label is already voided");

	const { shipment, order, channel } = await load(db, shipmentId);
	let refundStatus: string;
	try {
		({ status: refundStatus } = await outside.refund(shipment.externalId));
	} catch (err) {
		// No refund, so the label still counts.
		await db
			.update(shipments)
			.set({ voidedAt: null })
			.where(eq(shipments.id, shipmentId));
		throw err;
	}
	await db
		.update(shipments)
		.set({ refundStatus })
		.where(eq(shipments.id, shipmentId));

	const notes: string[] = [];
	// Whether the marketplace now agrees the order isn't shipped.
	let backToShip = !shipment.channelSentAt;
	if (shipment.channelSentAt && channel === "shopify") {
		try {
			if (!shipment.channelFulfillmentId)
				throw new Error("no fulfillment id saved");
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

	const [stillLive] = await db
		.select({ id: shipments.id })
		.from(shipments)
		.where(
			and(
				eq(shipments.orderId, order.id),
				isNull(shipments.voidedAt),
				ne(shipments.id, shipmentId),
			),
		)
		.limit(1);
	if (backToShip && !stillLive && order.fulfillmentStatus === "FULFILLED") {
		await db
			.update(orders)
			.set({ fulfillmentStatus: "UNFULFILLED" })
			.where(eq(orders.id, order.id));
		await assignOrderPins(db);
		notes.push("The order is back on To ship");
	}
	return { refundStatus, notes };
}
