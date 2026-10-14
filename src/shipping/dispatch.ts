import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { dispatchOrders, orders, shipments, stores } from "#/db/schema";
import { externalFulfillment, labelSource } from "#/orders/fulfillment";
import { needsShipping } from "#/orders/to-ship";

// The rules for what can go out together. A dispatch is one send to one
// address: one or more boxes, for one or more orders (see schema.ts).

// Buying, sending, and voiding take turns per order, holding the locks across
// the outside calls, so a double press or two people can't buy twice, refund
// twice, or send tracking for a label being voided. Several orders lock in id
// order, so two combined dispatches can't deadlock. A crash mid-way rolls back
// with the transaction.
export async function withOrderLocks<T>(
	db: Db,
	orderIds: number[],
	work: (tx: Db) => Promise<T>,
): Promise<T> {
	const ids = [...new Set(orderIds)].sort((a, b) => a - b);
	return db.transaction(async (tx) => {
		for (const id of ids) {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext('order-labels'), ${id})`,
			);
		}
		return work(tx);
	});
}

// The orders a dispatch was bought for.
export async function ordersOf(db: Db, dispatchId: number) {
	const rows = await db
		.select({ orderId: dispatchOrders.orderId })
		.from(dispatchOrders)
		.where(eq(dispatchOrders.dispatchId, dispatchId));
	if (rows.length === 0) throw new Error(`No dispatch ${dispatchId}`);
	return rows.map((r) => r.orderId);
}

// The live dispatch each of these orders is already in, if any.
export async function liveDispatches(db: Db, orderIds: number[]) {
	if (orderIds.length === 0) return [];
	return db
		.selectDistinct({
			orderId: dispatchOrders.orderId,
			dispatchId: dispatchOrders.dispatchId,
		})
		.from(dispatchOrders)
		.innerJoin(shipments, eq(shipments.dispatchId, dispatchOrders.dispatchId))
		.where(
			and(
				inArray(dispatchOrders.orderId, orderIds),
				isNull(shipments.voidedAt),
			),
		);
}

type AddressFields = {
	shipAddress1: string | null;
	shipAddress2: string | null;
	shipPostalCode: string | null;
	shipCountry: string | null;
};

// Two orders go to the same place when street, unit, ZIP, and country match,
// ignoring case, punctuation, and spacing ("12 Oak St." and "12 oak st"). US
// ZIP+4 compares on the first five digits. Null when the address is
// incomplete, so it never matches anything.
export function addressKey(o: AddressFields): string | null {
	const clean = (s: string | null) =>
		(s ?? "").toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
	const country = clean(o.shipCountry);
	const zip = clean(o.shipPostalCode).replace(/\s/g, "");
	const street = clean(o.shipAddress1);
	if (!street || !zip || !country) return null;
	const postal = country === "us" ? zip.slice(0, 5) : zip;
	return [street, clean(o.shipAddress2), postal, country].join("|");
}

const candidateFields = {
	id: orders.id,
	name: orders.name,
	pin: orders.pin,
	customerName: orders.customerName,
	channel: stores.channel,
	salesChannel: orders.salesChannel,
	marketplaceOrderId: orders.marketplaceOrderId,
	total: orders.total,
	needsShipping,
	shipAddress1: orders.shipAddress1,
	shipAddress2: orders.shipAddress2,
	shipPostalCode: orders.shipPostalCode,
	shipCountry: orders.shipCountry,
};
type Candidate = {
	id: number;
	name: string;
	channel: string;
	salesChannel: string | null;
	marketplaceOrderId: string | null;
	needsShipping: boolean;
} & AddressFields;

// Why these orders can't go out together in one dispatch, or null if they
// can. Every order must still need shipping, have no live dispatch, take a
// label katasync buys itself, share one label seller, and (with more than
// one) go to the same address.
export function whyNotTogether(
	list: Candidate[],
	live: { orderId: number }[],
): string | null {
	if (list.length === 0) return "No orders to ship";
	for (const o of list) {
		if (!o.needsShipping) {
			return `${o.name} no longer needs shipping (cancelled, refunded, or shipped elsewhere). Don't ship it.`;
		}
		if (live.some((l) => l.orderId === o.id)) {
			return `${o.name} already has a label. Void it on the order page to buy a new one.`;
		}
		const external = externalFulfillment(o);
		if (external) return `${o.name} ships on ${external.name}'s own label`;
	}
	const sources = new Set(list.map((o) => labelSource(o)));
	if (sources.size > 1) {
		return "TikTok orders ship on TikTok's labels, so they can't share a box with other orders";
	}
	if (list.length > 1) {
		const keys = new Set(list.map(addressKey));
		if (keys.has(null) || keys.size > 1) {
			return "These orders don't go to the same address";
		}
	}
	return null;
}

// Checks, under the orders' locks, that they can go out together; throws why
// not.
export async function assertTogether(db: Db, orderIds: number[]) {
	const list = await db
		.select(candidateFields)
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(inArray(orders.id, orderIds));
	if (list.length !== new Set(orderIds).size) {
		throw new Error("One of these orders no longer exists");
	}
	const why = whyNotTogether(list, await liveDispatches(db, orderIds));
	if (why) throw new Error(why);
	return list;
}

// Other orders still to ship to the same address as this one, that could go
// in the same box: quick ship offers them. Narrowed by ZIP in SQL, then
// matched on the full address.
export async function companionsOf(db: Db, order: Candidate) {
	const key = addressKey(order);
	if (!key || !order.shipPostalCode) return [];
	const zip5 = order.shipPostalCode.trim().slice(0, 5);
	const nearby = await db
		.select(candidateFields)
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(
			and(
				ne(orders.id, order.id),
				needsShipping,
				sql`left(trim(${orders.shipPostalCode}), 5) = ${zip5}`,
			),
		)
		.orderBy(orders.placedAt);
	const live = await liveDispatches(
		db,
		nearby.map((o) => o.id),
	);
	return nearby.filter(
		(o) => addressKey(o) === key && whyNotTogether([order, o], live) === null,
	);
}
