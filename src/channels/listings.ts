import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { listings, productAliases, products, stores } from "#/db/schema";
import { LedgerError } from "#/inventory/ledger";
import { listingEnded } from "#/products/archive";
import { awaitingProduct } from "./unmatched";

export type ChannelListing = {
	externalId: string;
	externalSku: string | null;
	title: string;
	fulfillment: "merchant" | "fba";
	// Shopify's product filing; see the listings table.
	tags?: string[];
	productType?: string | null;
	vendor?: string | null;
	status?: string | null;
};

// Records what a channel currently lists. Updates listing details but never
// touches mappings, except to unmap a listing whose SKU changed, or one that
// became FBA while mapped to a bundle: Amazon stocks physical units, so a
// virtual bundle can't back it.
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

		// One insert can't touch a row twice, and a channel can report a
		// listing twice (eBay, a SKU on two pages), so each counts once.
		const unique = new Map<string, ChannelListing>();
		for (const l of incoming)
			if (!unique.has(l.externalId)) unique.set(l.externalId, l);
		const rows = [...unique.values()];
		// Batched: Postgres takes at most 65,535 parameters per query.
		for (let i = 0; i < rows.length; i += INSERT_BATCH)
			await upsertListings(tx, storeId, rows.slice(i, i + INSERT_BATCH));

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
		// A listing back on sale (republished, reactivated) whose product was
		// archived meanwhile is unmatched, so it shows as needing a product.
		await tx
			.update(listings)
			.set({ productId: null })
			.where(
				and(
					eq(listings.storeId, storeId),
					sql`not ${listingEnded}`,
					inArray(
						listings.productId,
						tx
							.select({ id: products.id })
							.from(products)
							.where(isNotNull(products.archivedAt)),
					),
				),
			);
		return { unmapped: unmapped.map((l) => l.id) };
	});
}

// After a complete pass of a store's listings (every page read, none
// failed), marks the ones it didn't report as gone from the channel. Only
// rows that change are written. An empty pass marks nothing: a channel
// answering with no listings at all is more likely broken than empty.
export async function markGoneListings(
	db: Db,
	storeId: number,
	reported: string[],
): Promise<number> {
	if (reported.length === 0) return 0;
	const gone = await db
		.update(listings)
		.set({ goneAt: sql`now()` })
		.where(
			and(
				eq(listings.storeId, storeId),
				isNull(listings.goneAt),
				sql`${listings.externalId} not in (select jsonb_array_elements_text(${JSON.stringify(reported)}::jsonb))`,
			),
		)
		.returning({ id: listings.id });
	return gone.length;
}

// Rows per listings insert, well under Postgres's parameter cap.
const INSERT_BATCH = 1000;

async function upsertListings(
	tx: Db,
	storeId: number,
	batch: ChannelListing[],
) {
	await tx
		.insert(listings)
		.values(batch.map((l) => ({ ...l, storeId })))
		.onConflictDoUpdate({
			target: [listings.storeId, listings.externalId],
			set: {
				// A listing whose SKU changed on the channel may sell something
				// else now, so it loses its product; matching runs again after.
				productId: sql`case when nullif(trim(${listings.externalSku}), '') is distinct from nullif(trim(excluded.external_sku), '') then null else ${listings.productId} end`,
				externalSku: sql`excluded.external_sku`,
				title: sql`excluded.title`,
				fulfillment: sql`excluded.fulfillment`,
				tags: sql`excluded.tags`,
				productType: sql`excluded.product_type`,
				vendor: sql`excluded.vendor`,
				status: sql`excluded.status`,
				// Reported again, so it's back on the channel.
				goneAt: null,
				updatedAt: sql`now()`,
			},
			// Every listing comes back on every pass and almost none changed;
			// rewriting them all anyway was most of the database's writes.
			setWhere: sql`(${listings.externalSku}, ${listings.title}, ${listings.fulfillment}, ${listings.tags}, ${listings.productType}, ${listings.vendor}, ${listings.status})
				is distinct from (excluded.external_sku, excluded.title, excluded.fulfillment, excluded.tags, excluded.product_type, excluded.vendor, excluded.status)
				or ${listings.goneAt} is not null`,
		});
}

// Gives products without a photo the one their listing shows on the
// channel. A photo already set is never replaced, so one chosen by hand (or
// kept from Sumtracker) stays. Run after matching, since it goes through
// each listing's product. Returns how many products got a photo.
export async function fillProductImages(
	db: Db,
	storeId: number,
	images: { externalId: string; imageUrl: string }[],
): Promise<number> {
	let filled = 0;
	// Batched so one statement never carries thousands of parameters.
	for (let i = 0; i < images.length; i += 500) {
		const shown = images
			.slice(i, i + 500)
			.map((x) => sql`(${x.externalId}, ${x.imageUrl})`);
		const { rows } = (await db.execute(sql`
			update ${products} set image_url = shown.url
			from ${listings}
			join (values ${sql.join(shown, sql`, `)}) as shown(external_id, url)
				on shown.external_id = ${listings.externalId}
			where ${listings.storeId} = ${storeId}
				and ${listings.productId} = ${products.id}
				and ${products.imageUrl} is null
			returning ${products.id}`)) as unknown as { rows: unknown[] };
		filled += rows.length;
	}
	return filled;
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
			// Share-locked so the product can't be archived mid-match.
			const [sku] = await tx
				.select()
				.from(products)
				.where(eq(products.id, productId))
				.for("share");
			if (!sku) throw new LedgerError(`Unknown product ${productId}`);
			if (sku.archivedAt)
				throw new LedgerError(
					`${sku.sku} is archived; restore it before matching listings to it`,
				);
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
// "TT-052576") when exactly one product matches, archived or not. Archived
// products are never the match. Returns the listings mapped. Anything else is
// left for a person.
export async function autoMapListings(db: Db): Promise<number[]> {
	// Archived products never take a listing on their own.
	const notFbaBundle = and(
		sql`not (${listings.fulfillment} = 'fba' and ${products.kind} = 'bundle')`,
		isNull(products.archivedAt),
	);
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
				awaitingProduct,
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
		const product = await createProductNamed(tx, {
			sku,
			name: cleanTitle(listing.title),
		});
		await tx
			.update(listings)
			.set({ productId: product.id })
			.where(eq(listings.id, listingId));
		return product;
	});
}

// A new simple product, refused when its SKU exists in any capitals.
export async function createProductNamed(
	db: Db,
	{ sku, name }: { sku: string; name: string },
) {
	const [taken] = await db
		.select({ sku: products.sku, archivedAt: products.archivedAt })
		.from(products)
		.where(sql`lower(${products.sku}) = lower(${sku})`);
	if (taken?.archivedAt)
		throw new LedgerError(
			`${taken.sku} is archived; restore it to sell it again, or change the listing's SKU on the channel`,
		);
	if (taken) {
		throw new LedgerError(
			`${taken.sku} already exists; match the listing to it instead`,
		);
	}
	const [product] = await db
		.insert(products)
		.values({ sku, name, kind: "simple" })
		.returning({ id: products.id, sku: products.sku });
	return product;
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
