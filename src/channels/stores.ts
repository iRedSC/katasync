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
