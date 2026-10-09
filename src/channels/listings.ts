import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { listings, productAliases, products, stores } from "#/db/schema";
import { LedgerError } from "#/inventory/ledger";

export type ChannelListing = {
	externalId: string;
	externalSku: string | null;
	title: string;
	fulfillment: "merchant" | "fba";
};

// Records what a channel currently lists. Updates listing details but never
// touches mappings, except to unmap a listing that became FBA while mapped to
// a bundle: Amazon stocks physical units, so a virtual bundle can't back it.
// Returns the IDs of listings unmapped that way so they can be flagged.
export async function syncListings(
	db: Db,
	storeId: number,
	incoming: ChannelListing[],
): Promise<{ unmapped: number[] }> {
	if (incoming.length === 0) return { unmapped: [] };
	return db.transaction(async (tx) => {
		const [store] = await tx
			.select()
			.from(stores)
			.where(eq(stores.id, storeId));
		if (!store) throw new LedgerError(`Unknown store ${storeId}`);
		if (
			store.channel !== "amazon" &&
			incoming.some((l) => l.fulfillment === "fba")
		) {
			throw new LedgerError(
				`Only Amazon listings can be FBA (store ${store.name})`,
			);
		}

		await tx
			.insert(listings)
			.values(incoming.map((l) => ({ ...l, storeId })))
			.onConflictDoUpdate({
				target: [listings.storeId, listings.externalId],
				set: {
					externalSku: sql`excluded.external_sku`,
					title: sql`excluded.title`,
					fulfillment: sql`excluded.fulfillment`,
					updatedAt: sql`now()`,
				},
			});

		const unmapped = await tx
			.update(listings)
			.set({ productId: null })
			.where(
				and(
					eq(listings.storeId, storeId),
					eq(listings.fulfillment, "fba"),
					inArray(
						listings.productId,
						tx
							.select({ id: products.id })
							.from(products)
							.where(eq(products.kind, "bundle")),
					),
				),
			)
			.returning({ id: listings.id });
		return { unmapped: unmapped.map((l) => l.id) };
	});
}

// Maps a listing to the SKU it sells, or unmaps it with null.
export async function mapListing(
	db: Db,
	listingId: number,
	productId: number | null,
) {
	return db.transaction(async (tx) => {
		const [listing] = await tx
			.select()
			.from(listings)
			.where(eq(listings.id, listingId));
		if (!listing) throw new LedgerError(`Unknown listing ${listingId}`);
		if (productId !== null) {
			const [sku] = await tx
				.select()
				.from(products)
				.where(eq(products.id, productId));
			if (!sku) throw new LedgerError(`Unknown product ${productId}`);
			if (listing.fulfillment === "fba" && sku.kind === "bundle") {
				throw new LedgerError(
					`FBA listing ${listing.externalId} can't sell bundle ${sku.sku}; Amazon needs physical units`,
				);
			}
		}
		await tx
			.update(listings)
			.set({ productId })
			.where(eq(listings.id, listingId));
	});
}

// Maps every unmapped listing whose channel SKU exactly matches a product SKU
// or alias. Returns how many were mapped. Anything else is left for a person.
export async function autoMapListings(db: Db): Promise<number> {
	return db.transaction(async (tx) => {
		const bySku = await tx
			.update(listings)
			.set({ productId: products.id })
			.from(products)
			.where(
				and(
					isNull(listings.productId),
					eq(listings.externalSku, products.sku),
					sql`not (${listings.fulfillment} = 'fba' and ${products.kind} = 'bundle')`,
				),
			)
			.returning({ id: listings.id });
		const byAlias = await tx
			.update(listings)
			.set({ productId: products.id })
			.from(productAliases)
			.innerJoin(products, eq(products.id, productAliases.productId))
			.where(
				and(
					isNull(listings.productId),
					eq(listings.externalSku, productAliases.alias),
					sql`not (${listings.fulfillment} = 'fba' and ${products.kind} = 'bundle')`,
				),
			)
			.returning({ id: listings.id });
		return bySku.length + byAlias.length;
	});
}

export async function getUnmappedListings(db: Db) {
	return db
		.select({
			id: listings.id,
			store: stores.name,
			channel: stores.channel,
			externalId: listings.externalId,
			externalSku: listings.externalSku,
			title: listings.title,
			fulfillment: listings.fulfillment,
		})
		.from(listings)
		.innerJoin(stores, eq(stores.id, listings.storeId))
		.where(isNull(listings.productId))
		.orderBy(stores.name, listings.title);
}

// Listings selling any of these SKUs: the ones that need a new quantity when
// their stock changes. Pair with getBundlesContaining for component changes.
export async function getListingsForProducts(db: Db, productIds: number[]) {
	if (productIds.length === 0) return [];
	return db
		.select({
			id: listings.id,
			storeId: listings.storeId,
			channel: stores.channel,
			externalId: listings.externalId,
			fulfillment: listings.fulfillment,
			productId: listings.productId,
		})
		.from(listings)
		.innerJoin(stores, eq(stores.id, listings.storeId))
		.where(inArray(listings.productId, productIds));
}
