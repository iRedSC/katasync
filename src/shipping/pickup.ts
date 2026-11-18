import { eq } from "drizzle-orm";
import {
	ingestShopifyOrder,
	shopifyCancelFulfillment,
	shopifyFulfill,
} from "#/channels/shopify";
import { pickupOpen, shopifyReadyForPickup } from "#/channels/shopify/pickup";
import type { Db } from "#/db/client";
import { orders, stores } from "#/db/schema";
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
// the order leaves To ship at once. Ready isn't required first, for a buyer
// who walks in before the email goes.
export async function markPickedUp(
	db: Db,
	orderId: number,
	outside: PickupOutside = live,
): Promise<{ name: string; fulfillmentId: string; problems: string[] }> {
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
		await db
			.update(orders)
			.set({
				fulfillmentStatus:
					delivered.remaining > 0 ? "PARTIALLY_FULFILLED" : "FULFILLED",
			})
			.where(eq(orders.id, orderId));
		const problems = await reread(db, order, outside);
		return {
			name: order.name,
			fulfillmentId: delivered.fulfillmentId,
			problems,
		};
	});
}

// Takes a picked up back: Shopify's fulfillment is cancelled, so the order
// is waiting for pickup again, with its stock held.
export async function undoPickedUp(
	db: Db,
	orderId: number,
	fulfillmentId: string,
	outside: PickupOutside = live,
): Promise<{ name: string; problems: string[] }> {
	return outside.lock([orderId], async () => {
		const [order] = await db
			.select({
				name: orders.name,
				externalId: orders.externalId,
				pickup: orders.pickup,
			})
			.from(orders)
			.where(eq(orders.id, orderId));
		if (!order) throw new Error(`No order ${orderId}`);
		if (!order.pickup) throw new Error(`${order.name} isn't a pickup`);
		await outside.unfulfill(fulfillmentId);
		return { name: order.name, problems: await reread(db, order, outside) };
	});
}

// Shopify has the change; a failed read back only delays the stock and
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
			`${order.name}'s stock settles on the next sync (${error instanceof Error ? error.message : String(error)})`,
		]);
