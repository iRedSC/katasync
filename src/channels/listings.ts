import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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

// Maps every unmapped listing to the product its channel SKU names: an exact
// SKU or alias first, then the same SKU in different capitals ("tt-052576" for
// "TT-052576") when exactly one product matches. Returns the listings mapped.
// Anything else is left for a person.
export async function autoMapListings(db: Db): Promise<number[]> {
	const notFbaBundle = sql`not (${listings.fulfillment} = 'fba' and ${products.kind} = 'bundle')`;
	return db.transaction(async (tx) => {
		const bySku = await tx
			.update(listings)
			.set({ productId: products.id })
			.from(products)
			.where(
				and(
					isNull(listings.productId),
					eq(listings.externalSku, products.sku),
					notFbaBundle,
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
					notFbaBundle,
				),
			)
			.returning({ id: listings.id });
		const byCase = await tx
			.update(listings)
			.set({ productId: products.id })
			.from(products)
			.where(
				and(
					isNull(listings.productId),
					sql`lower(trim(${listings.externalSku})) = lower(${products.sku})`,
					sql`(select count(*) from ${products} p2 where lower(p2.sku) = lower(trim(${listings.externalSku}))) = 1`,
					notFbaBundle,
				),
			)
			.returning({ id: listings.id });
		return [...bySku, ...byAlias, ...byCase].map((l) => l.id);
	});
}

// Everything a listings sync does to connect listings to products: match by
// SKU, then give each of the primary store's still-unmatched listings a
// product of its own, then match again so other stores' listings with those
// SKUs land on the new products. Listings with no SKU are custom items and
// stay alone. Returns the listings now mapped (for catching up past orders)
// and the SKUs that couldn't become products.
export async function matchListings(
	db: Db,
): Promise<{ mapped: number[]; created: number; skipped: string[] }> {
	const first = await autoMapListings(db);
	const pending = await db
		.select({ id: listings.id, sku: listings.externalSku })
		.from(listings)
		.innerJoin(stores, eq(stores.id, listings.storeId))
		.where(
			and(
				eq(stores.primary, true),
				isNull(listings.productId),
				isNotNull(listings.externalSku),
			),
		)
		.orderBy(listings.id);
	const created: number[] = [];
	const skipped: string[] = [];
	for (const listing of pending) {
		try {
			await createProductFromListing(db, listing.id);
			created.push(listing.id);
		} catch (err) {
			// Usually the same SKU in other capitals; a person decides.
			if (!(err instanceof LedgerError)) throw err;
			skipped.push(`${listing.sku}: ${err.message}`);
		}
	}
	const second = created.length > 0 ? await autoMapListings(db) : [];
	return {
		mapped: [...first, ...created, ...second],
		created: created.length,
		skipped,
	};
}

// Turns a listing for something not yet in the catalog into a product,
// filled in from the listing, and maps the listing to it.
export async function createProductFromListing(db: Db, listingId: number) {
	return db.transaction(async (tx) => {
		const [listing] = await tx
			.select()
			.from(listings)
			.where(eq(listings.id, listingId));
		if (!listing) throw new LedgerError(`Unknown listing ${listingId}`);
		const sku = listing.externalSku?.trim();
		if (!sku)
			throw new LedgerError("This listing has no SKU, so it's a custom item");
		const [taken] = await tx
			.select({ sku: products.sku })
			.from(products)
			.where(sql`lower(${products.sku}) = lower(${sku})`);
		if (taken) {
			throw new LedgerError(
				`${taken.sku} already exists; match the listing to it instead`,
			);
		}
		const [product] = await tx
			.insert(products)
			.values({ sku, name: cleanTitle(listing.title), kind: "simple" })
			.returning({ id: products.id, sku: products.sku });
		await tx
			.update(listings)
			.set({ productId: product.id })
			.where(eq(listings.id, listingId));
		return product;
	});
}

// Shopify names single-variant products "Name - Default Title".
export function cleanTitle(title: string) {
	return title.replace(/ - Default Title$/, "").trim();
}

export async function getUnmappedListings(db: Db) {
	return (
		db
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
			// Listings with no SKU are custom products; there's nothing to match.
			.where(and(isNull(listings.productId), isNotNull(listings.externalSku)))
			.orderBy(stores.name, listings.title)
	);
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
