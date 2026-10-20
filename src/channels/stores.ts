import { and, eq, max } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, movements, stores } from "#/db/schema";

// The store row for a channel account, created on first sync. A new store
// starts taking stock from the most recent opening balance, since anything
// sold before that is already reflected in it.
export async function ensureStore(
	db: Db,
	channel: (typeof stores.$inferInsert)["channel"],
	name: string,
) {
	const [existing] = await db
		.select()
		.from(stores)
		.where(and(eq(stores.channel, channel), eq(stores.name, name)));
	if (existing) return existing;
	const [{ openedAt }] = await db
		.select({ openedAt: max(movements.createdAt) })
		.from(movements)
		.where(eq(movements.reason, "opening_balance"));
	const [created] = await db
		.insert(stores)
		.values({ channel, name, stockFrom: openedAt })
		.returning();
	return created;
}

// Where sold stock comes from. With one owned location that's obvious; with
// several, katasync can't guess, so orders report it instead of taking stock
// from the wrong shelf.
export async function shippingLocation(db: Db): Promise<number | null> {
	const owned = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"));
	return owned.length === 1 ? owned[0].id : null;
}

// Where each kind of sale takes stock from: shipped orders from the
// warehouse, then the retail store for what the warehouse is out of (the
// order page says to fetch those); in-store sales from the retail store
// only. Null where katasync can't tell (none, or several), so the order
// reports it instead.
export type StockLocations = { shipping: number | null; store: number | null };

export async function stockLocations(db: Db): Promise<StockLocations> {
	const retail = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "retail"));
	return {
		shipping: await shippingLocation(db),
		store: retail.length === 1 ? retail[0].id : null,
	};
}

// The shelf one order's stock comes off, and the one that covers what it's
// out of, or why there isn't one.
export function saleLocation(
	from: StockLocations,
	order: { soldInStore: boolean },
): { locationId: number; overflowId: number | null } | { problem: string } {
	if (order.soldInStore && from.store !== null)
		return { locationId: from.store, overflowId: null };
	if (!order.soldInStore && from.shipping !== null)
		return { locationId: from.shipping, overflowId: from.store };
	return {
		problem: order.soldInStore
			? "no retail store to take in-store stock from"
			: "no location to take stock from",
	};
}

// Moves the sync cursor forward. Only ever forward, so a slow or partial pass
// can't make the next one skip orders.
export async function advanceOrderCursor(db: Db, storeId: number, to: Date) {
	const [store] = await db.select().from(stores).where(eq(stores.id, storeId));
	if (store.ordersSyncedThrough && store.ordersSyncedThrough >= to) return;
	await db
		.update(stores)
		.set({ ordersSyncedThrough: to })
		.where(eq(stores.id, storeId));
}
