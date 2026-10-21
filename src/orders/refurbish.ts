import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { shopifyAdminProductUrl } from "#/channels/shopify/admin-url";
import {
	type Condition,
	createRefurbDraft,
	deleteShopifyVariant,
	shopifyConditions,
	shopifyOriginal,
} from "#/channels/shopify/refurbish";
import type { Db } from "#/db/client";
import {
	listings,
	locations,
	orderLines,
	productAliases,
	products,
	stockLevels,
	stores,
} from "#/db/schema";
import { isOurs } from "#/inventory/locations";
import { carried, listingEnded } from "#/products/archive";
import { ReturnError, receiveReturn } from "./returns";

// Refurbished one-offs, made from a returned unit at the bench: a draft in
// Shopify (condition in metafield custom.condition, which the theme shows)
// and a product here, linked, with the returned units as its stock. Its
// cost is what the unit cost when it sold, so the order it came back from
// isn't charged for it and its own sale is. A refurb of the same thing in
// the same condition can take more units instead. Retired once sold out
// (src/orders/refurb-retire.ts).

// What the refurb dialog starts from.
export type RefurbishOptions = {
	original: { sku: string; name: string };
	conditions: Condition[];
	title: string;
	price: number;
	sku: string;
	// Refurbs of it still carried, to add the units to instead.
	existing: { id: number; sku: string; condition: string; onHand: number }[];
};

async function originalOf(db: Db, orderId: number, lineId: number) {
	const [line] = await db
		.select({
			productId: orderLines.productId,
			unitPrice: orderLines.unitPrice,
			unitCost: orderLines.unitCost,
			title: orderLines.title,
		})
		.from(orderLines)
		.where(and(eq(orderLines.id, lineId), eq(orderLines.orderId, orderId)));
	if (!line) throw new ReturnError(`No line ${lineId} on that order`);
	if (line.productId === null)
		throw new ReturnError(
			`Match ${line.title} to a product before refurbishing it`,
		);
	const [product] = await db
		.select()
		.from(products)
		.where(eq(products.id, line.productId));
	// Its live Shopify listing, to copy the product's page from.
	const [listing] = await db
		.select({ storeId: listings.storeId, variantId: listings.externalId })
		.from(listings)
		.innerJoin(stores, eq(stores.id, listings.storeId))
		.where(
			and(
				eq(listings.productId, product.id),
				eq(stores.channel, "shopify"),
				sql`not ${listingEnded}`,
			),
		)
		.orderBy(asc(listings.id))
		.limit(1);
	return { line, product, listing: listing ?? null };
}

// The next free "<SKU>-R<n>", in any capitals, counting aliases.
async function nextRefurbSku(db: Db, base: string) {
	const pattern = `${base.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}-r%`;
	const taken = await db
		.select({ sku: products.sku })
		.from(products)
		.where(sql`lower(${products.sku}) like ${pattern}`)
		.union(
			db
				.select({ sku: productAliases.alias })
				.from(productAliases)
				.where(sql`lower(${productAliases.alias}) like ${pattern}`),
		);
	const used = taken.flatMap(
		(t) => t.sku.slice(base.length).match(/^-r(\d+)$/i)?.[1] ?? [],
	);
	const n = Math.max(0, ...used.map(Number)) + 1;
	return { sku: `${base}-R${n}`, n };
}

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

export async function refurbishOptions(
	db: Db,
	input: { orderId: number; lineId: number },
): Promise<RefurbishOptions> {
	const { line, product, listing } = await originalOf(
		db,
		input.orderId,
		input.lineId,
	);
	const [shop, conditions, { sku }, existing] = await Promise.all([
		listing ? shopifyOriginal(listing.variantId) : null,
		shopifyConditions(),
		nextRefurbSku(db, product.sku),
		db
			.select({
				id: products.id,
				sku: products.sku,
				condition: sql<string>`${products.condition}`,
				onHand: sql<number>`coalesce(sum(${stockLevels.onHand}) filter (where ${isOurs}), 0)::int`,
			})
			.from(products)
			.leftJoin(stockLevels, eq(stockLevels.productId, products.id))
			.leftJoin(locations, eq(locations.id, stockLevels.locationId))
			.where(
				and(
					eq(products.refurbishedFromId, product.id),
					isNotNull(products.condition),
					carried,
				),
			)
			.groupBy(products.id)
			.orderBy(asc(products.id)),
	]);
	return {
		original: { sku: product.sku, name: product.name },
		conditions,
		title: shop?.product.title ?? product.name,
		price: shop ? Number(shop.price) : line.unitPrice,
		sku,
		existing,
	};
}

// Makes the refurb and receives the line's units into it. Shopify's draft
// is made inside the transaction, holding the original product's row, so
// two people can't make the same SKU at once; if anything here fails after
// it, the draft is deleted again and nothing is left half made.
export async function refurbishReturn(
	db: Db,
	input: {
		orderId: number;
		lineId: number;
		quantity: number;
		condition: string;
		title: string;
		price: number;
	},
) {
	const title = input.title.trim();
	if (!title) throw new ReturnError("Give it a title");
	if (!(input.price > 0)) throw new ReturnError("Give it a price");
	const condition = (await shopifyConditions()).find(
		(c) => c.handle === input.condition,
	);
	if (!condition)
		throw new ReturnError(`Shopify has no condition "${input.condition}"`);
	const { line, product, listing } = await originalOf(
		db,
		input.orderId,
		input.lineId,
	);
	const shop = listing ? await shopifyOriginal(listing.variantId) : null;
	const [store] = listing
		? [{ id: listing.storeId }]
		: await db
				.select({ id: stores.id })
				.from(stores)
				.where(eq(stores.channel, "shopify"))
				.orderBy(asc(stores.id))
				.limit(1);
	if (!store) throw new ReturnError("No Shopify store is synced yet");
	const unitCost = line.unitCost ?? product.unitCost;

	return db.transaction(async (tx) => {
		await tx
			.select({ id: products.id })
			.from(products)
			.where(eq(products.id, product.id))
			.for("update");
		const { sku, n } = await nextRefurbSku(tx, product.sku);
		const draft = await createRefurbDraft({
			handle: `${shop?.product.handle ?? slug(title)}-refurbished-${n}`,
			title,
			descriptionHtml: shop?.product.descriptionHtml ?? "",
			vendor: shop?.product.vendor ?? "",
			productType: shop?.product.productType ?? "",
			conditionId: condition.id,
			sku,
			price: input.price,
			unitCost,
			quantity: input.quantity,
		});
		try {
			const [refurb] = await tx
				.insert(products)
				.values({
					sku,
					name: title,
					kind: "simple",
					refurbishedFromId: product.id,
					condition: condition.handle,
					unitCost,
					category: product.category,
					weightGrams: product.weightGrams,
					lengthMm: product.lengthMm,
					widthMm: product.widthMm,
					heightMm: product.heightMm,
					insureWhenShipped: product.insureWhenShipped,
					aerosol: product.aerosol,
				})
				.returning({ id: products.id });
			await tx.insert(listings).values({
				storeId: store.id,
				externalId: draft.variantId,
				externalSku: sku,
				title,
				status: "DRAFT",
				vendor: shop?.product.vendor || null,
				productType: shop?.product.productType || null,
				productId: refurb.id,
			});
			const { ids } = await receiveReturn(tx, {
				orderId: input.orderId,
				lines: [{ lineId: input.lineId, quantity: input.quantity }],
				outcome: { refurbishInto: refurb.id },
			});
			return {
				ids,
				sku,
				productId: refurb.id,
				shopifyUrl: shopifyAdminProductUrl(draft.productId),
			};
		} catch (error) {
			await deleteShopifyVariant(draft.variantId).catch(() => {});
			throw error;
		}
	});
}
