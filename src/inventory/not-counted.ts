import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, products } from "#/db/schema";
import { LedgerError, requestCounts } from "#/inventory/ledger";

// Not counted: a product nobody has counted yet sells without limit. Stock
// push sends every channel UNLIMITED for it (and for tool sets made only of
// such parts), while its sales still post to the ledger. Reordering, stock
// value, and stockout risk leave it out, since its number means nothing yet.
// It joins the count list, and the first shelf count (recordCount) ends it
// for good: from then on its ledger number is pushed like any other.

// What stock push sends for a product that sells without limit.
export const UNLIMITED = 999;

// Marks products as not counted and puts each on the count list at our first
// location. Products already marked stay as they were. Returns how many this
// marked.
export async function markNotCounted(db: Db, productIds: number[]) {
	if (productIds.length === 0) return 0;
	return db.transaction(async (tx) => {
		const bundles = await tx
			.select({ sku: products.sku })
			.from(products)
			.where(
				and(inArray(products.id, productIds), eq(products.kind, "bundle")),
			);
		if (bundles.length > 0)
			throw new LedgerError(
				`Tool sets have no stock of their own; mark their parts: ${bundles.map((b) => b.sku).join(", ")}`,
			);
		const [shelf] = await tx
			.select({ id: locations.id })
			.from(locations)
			.where(eq(locations.kind, "owned"))
			.orderBy(asc(locations.id))
			.limit(1);
		if (!shelf) throw new LedgerError("Add a location first");
		const marked = await tx
			.update(products)
			.set({ notCountedSince: new Date() })
			.where(
				and(inArray(products.id, productIds), isNull(products.notCountedSince)),
			)
			.returning({ id: products.id });
		await requestCounts(tx, {
			productIds: marked.map((m) => m.id),
			locationId: shelf.id,
		});
		return marked.length;
	});
}
