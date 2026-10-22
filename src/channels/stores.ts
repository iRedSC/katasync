import { and, eq, isNull, max, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, movements, stores } from "#/db/schema";
import type { Overflow } from "#/inventory/ledger";
import { posLocation } from "#/inventory/locations";
import { retailReserve } from "#/inventory/online-stock";

// The store row for a channel account, created on first sync and found by
// the channel's own account ID after that, so renaming the store on the
// channel renames the row instead of starting a second store. A row from
// before account IDs were kept is claimed by name. A new store starts taking
// stock from the most recent opening balance, since anything sold before
// that is already reflected in it.
export async function ensureStore(
	db: Db,
	channel: (typeof stores.$inferInsert)["channel"],
	account: { id: string; name: string },
) {
	const [known] = await db
		.select()
		.from(stores)
		.where(and(eq(stores.channel, channel), eq(stores.accountId, account.id)));
	if (known) {
		if (known.name === account.name) return known;
		const [renamed] = await db
			.update(stores)
			.set({ name: account.name })
			.where(eq(stores.id, known.id))
			.returning();
		return renamed;
	}
	const [unclaimed] = await db
		.update(stores)
		.set({ accountId: account.id })
		.where(
			and(
				eq(stores.channel, channel),
				eq(stores.name, account.name),
				isNull(stores.accountId),
			),
		)
		.returning();
	if (unclaimed) return unclaimed;
	const [{ openedAt }] = await db
		.select({ openedAt: max(movements.createdAt) })
		.from(movements)
		.where(eq(movements.reason, "opening_balance"));
	const [created] = await db
		.insert(stores)
		.values({
			channel,
			accountId: account.id,
			name: account.name,
			stockFrom: openedAt,
		})
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
// order page says to fetch those); in-store sales from the POS location
// (locations.posPrimary, set in Settings) only. Null where katasync can't
// tell (none, or several), so the order reports it instead.
// `storeKeeps` is how many the store holds back for walk-ins
// (settings.retailReserve); overflow takes only what's above it.
export type StockLocations = {
	shipping: number | null;
	store: number | null;
	pos: number | null;
	storeKeeps: number;
};

export async function stockLocations(db: Db): Promise<StockLocations> {
	const retail = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "retail"));
	return {
		shipping: await shippingLocation(db),
		store: retail.length === 1 ? retail[0].id : null,
		pos: await posLocation(db),
		storeKeeps: await retailReserve(db),
	};
}

// The shelf one order's stock comes off, and the one that covers what it's
// out of, or why there isn't one.
export function saleLocation(
	from: StockLocations,
	order: { soldInStore: boolean },
): { locationId: number; overflow: Overflow | null } | { problem: string } {
	if (order.soldInStore && from.pos !== null)
		return { locationId: from.pos, overflow: null };
	if (!order.soldInStore && from.shipping !== null)
		return {
			locationId: from.shipping,
			overflow:
				from.store === null
					? null
					: { locationId: from.store, keep: from.storeKeeps },
		};
	return {
		problem: order.soldInStore
			? "no POS location to take in-store stock from"
			: "no location to take stock from",
	};
}

// Moves the sync cursor forward. Only ever forward, and decided by the database
// in the one update, so a slow or partial pass (or one overlapping another)
// can't make the next one skip orders. greatest ignores a null cursor.
export async function advanceOrderCursor(db: Db, storeId: number, to: Date) {
	await db
		.update(stores)
		.set({
			ordersSyncedThrough: sql`greatest(${stores.ordersSyncedThrough}, ${to}::timestamptz)`,
		})
		.where(eq(stores.id, storeId));
}
