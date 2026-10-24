import { type } from "arktype";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { shopifyQuery } from "#/channels/shopify/client";
import type { Db } from "#/db/client";
import { listings, products, stores } from "#/db/schema";
import { type LaborVariant, variantMinutes } from "./labor";

// The Shopify variants a repair's lines are billed as.

const laborProducts = type({
	products: {
		nodes: type({
			title: "string",
			variants: {
				nodes: type({ id: "string", title: "string", price: "string" }).array(),
			},
		}).array(),
	},
});

let cached: { at: number; variants: LaborVariant[] } | null = null;
const FRESH_MS = 10 * 60_000;

// The labor product's variants, read from Shopify every ten minutes: the
// product tagged intangible whose title starts "Labor".
export async function laborVariants(): Promise<LaborVariant[]> {
	if (cached && Date.now() - cached.at < FRESH_MS) return cached.variants;
	const data = laborProducts.assert(
		await shopifyQuery(
			`{ products(first: 5, query: "tag:intangible AND title:Labor*") { nodes { title variants(first: 50) { nodes { id title price } } } } }`,
			{},
		),
	);
	const product = data.products.nodes.find((p) => /^labor\b/i.test(p.title));
	const variants = (product?.variants.nodes ?? []).flatMap((v) => {
		const minutes = variantMinutes(v.title);
		return minutes
			? [{ variantId: v.id, minutes, price: Number(v.price) }]
			: [];
	});
	if (variants.length === 0)
		throw new Error(
			'No labor product in Shopify: one tagged "intangible", titled "Labor…", with variants like "15m" and "1h 15m"',
		);
	cached = { at: Date.now(), variants };
	return variants;
}

// Each product's Shopify variant: an active listing first, then any not
// gone from Shopify.
export async function shopifyVariants(db: Db, productIds: number[]) {
	if (productIds.length === 0) return new Map<number, string>();
	const rows = await db
		.select({ productId: listings.productId, externalId: listings.externalId })
		.from(listings)
		.innerJoin(stores, eq(stores.id, listings.storeId))
		.where(
			and(
				eq(stores.channel, "shopify"),
				inArray(listings.productId, productIds),
				isNull(listings.goneAt),
				sql`${listings.externalId} like 'gid://shopify/ProductVariant/%'`,
			),
		)
		.orderBy(
			sql`case when upper(coalesce(${listings.status}, '')) = 'ACTIVE' then 0 else 1 end`,
			asc(listings.id),
		);
	const found = new Map<number, string>();
	for (const r of rows)
		if (r.productId !== null && !found.has(r.productId))
			found.set(r.productId, r.externalId);
	return found;
}

// Products that can go on a repair: those Shopify sells.
export const onShopify = sql`exists (select 1 from ${listings} l join ${stores} s on s.id = l.store_id where s.channel = 'shopify' and l.product_id = ${products.id} and l.gone_at is null)`;
