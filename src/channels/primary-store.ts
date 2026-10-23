import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
import { applyListingsToOrders } from "#/orders/remap";
import { matchListings } from "./listings";
import { stockLocations } from "./stores";

// Makes one store the primary (or none, with id null): the store whose new
// listings become products. Then lets its unmatched listings become products
// right away instead of on the next sync.
export async function setPrimaryStore(db: Db, id: number | null) {
	await db.transaction(async (tx) => {
		await tx
			.update(stores)
			.set({ primary: false })
			.where(eq(stores.primary, true));
		if (id) {
			const set = await tx
				.update(stores)
				.set({ primary: true })
				.where(eq(stores.id, id))
				.returning({ id: stores.id });
			if (set.length === 0) throw new Error(`No store ${id}`);
		}
	});
	if (!id) return { created: 0, skipped: [] as string[] };
	const matched = await matchListings(db);
	await applyListingsToOrders(db, matched.mapped, await stockLocations(db));
	return { created: matched.created, skipped: matched.skipped };
}
