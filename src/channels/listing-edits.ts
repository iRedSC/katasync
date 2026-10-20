import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { listings, orderLines, orders, products, stores } from "#/db/schema";
import { LedgerError } from "#/inventory/ledger";
import { applyListingsToOrders } from "#/orders/remap";
import { autoMapListings, mapListing } from "./listings";
import { shippingLocation } from "./stores";
import { awaitingProduct } from "./unmatched";

// Changing which product listings sell, after they were matched. Past
// orders keep the product (and stock) they took; only later sales change.

type Linked = { id: number; title: string; productId: number; sku: string };

// The listings, each matched to a product. Locked until the change commits.
async function linkedListings(tx: Db, listingIds: number[]) {
	if (listingIds.length === 0) throw new LedgerError("No listings given");
	const rows = await tx
		.select({
			id: listings.id,
			title: listings.title,
			productId: listings.productId,
			sku: products.sku,
		})
		.from(listings)
		.leftJoin(products, eq(products.id, listings.productId))
		.where(inArray(listings.id, listingIds))
		.for("update", { of: listings });
	const missing = listingIds.filter((id) => !rows.some((r) => r.id === id));
	if (missing.length > 0)
		throw new LedgerError(`No listing ${missing.join(", ")}`);
	const loose = rows.filter((r) => r.productId === null);
	if (loose.length > 0)
		throw new LedgerError(
			`Not matched to a product: ${loose.map((r) => r.title).join(", ")}`,
		);
	// In the order given, so results line up with what was asked.
	return listingIds.map((id) => rows.find((r) => r.id === id)) as Linked[];
}

export type UnlinkedListing = {
	listingId: number;
	title: string;
	was: string;
	// What the listing sells now: a product its SKU names (matched at once,
	// as a sync would), a new product the next sync makes from it, or
	// nothing until someone matches it.
	now:
		| { kind: "matched"; sku: string }
		| { kind: "new_product_next_sync"; sku: string }
		| { kind: "unmatched"; why?: string };
};

// Unmatches listings, all or none, and matches them again by SKU the way a
// sync would, so what's returned is what stays. Refused when a listing's SKU
// would match it straight back to the same product: change the SKU on the
// channel, or relink it.
export async function unlinkListings(db: Db, listingIds: number[]) {
	const unlinked = await db.transaction(async (tx) => {
		const before = await linkedListings(tx, listingIds);
		await tx
			.update(listings)
			.set({ productId: null })
			.where(inArray(listings.id, listingIds));
		const rematched = await autoMapListings(tx);
		const after = await tx
			.select({
				id: listings.id,
				sku: products.sku,
				externalSku: listings.externalSku,
				primary: stores.primary,
				awaiting: sql<boolean>`coalesce((${awaitingProduct}), false)`,
				// A product already using the SKU in any capitals, which keeps a
				// sync from making one (an archived product, usually).
				taken: sql<
					string | null
				>`(select p.sku from ${products} p where lower(p.sku) = lower(trim(${listings.externalSku})) limit 1)`,
			})
			.from(listings)
			.innerJoin(stores, eq(stores.id, listings.storeId))
			.leftJoin(products, eq(products.id, listings.productId))
			.where(inArray(listings.id, listingIds));
		const result: UnlinkedListing[] = [];
		for (const old of before) {
			const row = after.find((a) => a.id === old.id);
			if (row?.sku === old.sku)
				throw new LedgerError(
					`${old.title}'s SKU is ${old.sku}'s, so syncing matches it straight back. Change the SKU on the channel, or relink it to another product`,
				);
			const sku = row?.externalSku?.trim();
			result.push({
				listingId: old.id,
				title: old.title,
				was: old.sku,
				now: row?.sku
					? { kind: "matched", sku: row.sku }
					: row?.taken
						? {
								kind: "unmatched",
								why: `${row.taken} has its SKU but can't take it (archived, or in other capitals)`,
							}
						: row?.primary && row.awaiting && sku
							? { kind: "new_product_next_sync", sku }
							: { kind: "unmatched" },
			});
		}
		return { result, rematched };
	});
	// Other listings the SKU pass matched take their past orders' stock now,
	// as after a sync; a sync won't see them as newly matched.
	const caughtUp = await applyListingsToOrders(
		db,
		unlinked.rematched.filter((id) => !listingIds.includes(id)),
		await shippingLocation(db),
	);
	return { listings: unlinked.result, problems: caughtUp.problems };
}

// Moves matched listings to another product, all or none.
export async function relinkListings(
	db: Db,
	listingIds: number[],
	sku: string,
) {
	return db.transaction(async (tx) => {
		const before = await linkedListings(tx, listingIds);
		const [product] = await tx
			.select({ id: products.id, sku: products.sku })
			.from(products)
			.where(eq(products.sku, sku.trim()));
		if (!product) throw new LedgerError(`No product with SKU ${sku}`);
		for (const l of before) await mapListing(tx, l.id, product.id);
		return before.map((l) => ({
			listingId: l.id,
			title: l.title,
			was: l.sku,
			now: product.sku,
		}));
	});
}

// Deletes listings gone from their channel (a full sync stopped reporting
// them) that never sold, all or none. Anything else is refused, saying why:
// a listing still on the channel comes back on the next sync, and one that
// sold is what its past orders are matched through.
export async function deleteListings(db: Db, listingIds: number[]) {
	if (listingIds.length === 0) throw new LedgerError("No listings given");
	return db.transaction(async (tx) => {
		const rows = await tx
			.select({
				id: listings.id,
				title: listings.title,
				store: stores.name,
				goneAt: listings.goneAt,
				sold: sql<boolean>`exists (select 1 from ${orderLines} join ${orders} on ${orders.id} = ${orderLines.orderId} where ${orders.storeId} = ${listings.storeId} and ${orderLines.listingExternalId} = ${listings.externalId})`,
			})
			.from(listings)
			.innerJoin(stores, eq(stores.id, listings.storeId))
			.where(inArray(listings.id, listingIds))
			.for("update", { of: listings });
		const refused = listingIds.map((id) => {
			const row = rows.find((r) => r.id === id);
			if (!row) return `No listing ${id}`;
			if (!row.goneAt)
				return `${row.title} is still on ${row.store}, so the next sync brings it back; end it there first`;
			if (row.sold)
				return `${row.title} sold, and its past orders are matched through it`;
			return null;
		});
		const why = refused.filter((r) => r !== null);
		if (why.length > 0) throw new LedgerError(why.join("; "));
		await tx.delete(listings).where(inArray(listings.id, listingIds));
		return rows.map((r) => ({
			listingId: r.id,
			title: r.title,
			store: r.store,
			goneSince: r.goneAt,
		}));
	});
}
