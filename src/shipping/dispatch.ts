import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { type Db, withOwnConnection } from "#/db/client";
import { dispatchOrders, orders, shipments, stores } from "#/db/schema";
import { externalFulfillment, labelSource } from "#/orders/fulfillment";
import { needsShipping } from "#/orders/to-ship";

// The rules for what can go out together. A dispatch is one send to one
// address: one or more boxes, for one or more orders (see schema.ts).

// Buying, sending, and voiding take turns per order, holding the locks
// across the outside calls, so a double press or two people can't buy twice,
// refund twice, or send tracking for a label being voided. Passed in with the
// other outside calls so tests can stand in for it.
export type OrderLocker = <T>(
	orderIds: number[],
	work: () => Promise<T>,
) => Promise<T>;

// The locks are held by a transaction on a connection of its own, so the
// work itself writes through the shared pool and each write commits as it
// happens: a label that was paid for is never rolled back by a later
// failure. Several orders lock in id order, so two combined dispatches can't
// deadlock. The lock goes when that transaction ends, however the work ends.
export const lockOnOwnConnection: OrderLocker = (orderIds, work) =>
	withOwnConnection((lockDb) =>
		lockDb.transaction(async (tx) => {
			for (const id of sortedIds(orderIds)) {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext('order-labels'), ${id})`,
				);
			}
			return work();
		}),
	);

// The same turn-taking within one process, for tests: PGlite has a single
// session, so it can't hold locks for another connection.
export function memoryLocker(): OrderLocker {
	const tails = new Map<number, Promise<unknown>>();
	return async (orderIds, work) => {
		const ids = sortedIds(orderIds);
		const releases: (() => void)[] = [];
		for (const id of ids) {
			const before = tails.get(id) ?? Promise.resolve();
			let release = () => {};
			const mine = new Promise<void>((r) => {
				release = r;
			});
			tails.set(
				id,
				before.then(() => mine),
			);
			await before;
			releases.push(release);
		}
		try {
			return await work();
		} finally {
			for (const release of releases) release();
		}
	};
}

const sortedIds = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b);

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
	// TikTok sells one label per order package; combining happens in Seller
	// Center.
	if (list.length > 1 && list.some((o) => labelSource(o) === "tiktok")) {
		return "TikTok orders ship on TikTok's labels, one order per box. Combine TikTok orders in TikTok Seller Center.";
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
	// The postal code's start, compared the way addressKey compares it.
	const zipStart = (zip: unknown) =>
		sql`left(regexp_replace(lower(${zip}), '[[:space:]]', '', 'g'), 5)`;
	const nearby = await db
		.select(candidateFields)
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(
			and(
				ne(orders.id, order.id),
				needsShipping,
				sql`${zipStart(orders.shipPostalCode)} = ${zipStart(order.shipPostalCode)}`,
			),
		)
		.orderBy(orders.placedAt);
	const live = await liveDispatches(db, [order.id, ...nearby.map((o) => o.id)]);
	return nearby.filter(
		(o) => addressKey(o) === key && whyNotTogether([order, o], live) === null,
	);
}
