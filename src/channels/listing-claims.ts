import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { listings, products } from "#/db/schema";
import { LedgerError } from "#/inventory/ledger";

// Listings locked until the transaction ends, with what they are now. Only
// lockListings makes one, so what was checked on them still holds when
// mapListings writes.
export type LockedListing = {
	id: number;
	externalId: string;
	externalSku: string | null;
	title: string;
	fulfillment: "merchant" | "fba";
	productId: number | null;
	// The SKU of the product it sells; null when it sells none.
	sku: string | null;
};

export type MatchedListing = LockedListing & { productId: number; sku: string };

export const isMatched = (l: LockedListing): l is MatchedListing =>
	l.productId !== null && l.sku !== null;

// Locks the listings, in id order so concurrent work takes locks in the same
// order, and returns them in the order given. All or none: refused when one is
// missing. Call it inside a transaction, which holds the locks until it ends.
export async function lockListings(
	tx: Db,
	listingIds: number[],
): Promise<LockedListing[]> {
	if (listingIds.length === 0) throw new LedgerError("No listings given");
	const rows = await tx
		.select({
			id: listings.id,
			externalId: listings.externalId,
			externalSku: listings.externalSku,
			title: listings.title,
			fulfillment: listings.fulfillment,
			productId: listings.productId,
			sku: products.sku,
		})
		.from(listings)
		.leftJoin(products, eq(products.id, listings.productId))
		.where(inArray(listings.id, listingIds))
		.orderBy(listings.id)
		.for("update", { of: listings });
	const byId = new Map(rows.map((r) => [r.id, r]));
	const unique = [...new Set(listingIds)];
	const missing = unique.filter((id) => !byId.has(id));
	if (missing.length > 0)
		throw new LedgerError(`No listing ${missing.join(", ")}`);
	return unique.flatMap((id) => byId.get(id) ?? []);
}

// Maps locked listings to a product, or unmaps them with null, all or none.
// The product is share-locked so it can't be archived mid-match, and each
// listing is checked against it: an FBA listing can't sell a bundle, since
// Amazon needs physical units. The update is by the locked IDs, and must
// touch every one.
export async function mapListings(
	tx: Db,
	locked: LockedListing[],
	productId: number | null,
) {
	if (productId !== null) {
		const [product] = await tx
			.select()
			.from(products)
			.where(eq(products.id, productId))
			.for("share");
		if (!product) throw new LedgerError(`Unknown product ${productId}`);
		if (product.archivedAt)
			throw new LedgerError(
				`${product.sku} is archived; restore it before matching listings to it`,
			);
		const fba = locked.find((l) => l.fulfillment === "fba");
		if (product.kind === "bundle" && fba)
			throw new LedgerError(
				`FBA listing ${fba.externalId} can't sell bundle ${product.sku}; Amazon needs physical units`,
			);
	}
	const written = await tx
		.update(listings)
		.set({ productId })
		.where(
			inArray(
				listings.id,
				locked.map((l) => l.id),
			),
		)
		.returning({ id: listings.id });
	if (written.length !== locked.length)
		throw new LedgerError("Listings changed while mapping; nothing was mapped");
}
