import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { shopifyAdminProductUrl } from "#/channels/shopify/admin-url";
import {
	type Condition,
	createRefurbDraft,
	deleteShopifyVariant,
	type ShopifyOriginal,
	shopifyConditions,
	shopifyOriginal,
	shopifySkuTaken,
	shopifyTags,
} from "#/channels/shopify/refurbish";
import type { Db } from "#/db/client";
import {
	listings,
	locations,
	orderLines,
	orders,
	productAliases,
	products,
	stockLevels,
	stores,
} from "#/db/schema";
import { readQuantityMode } from "#/inventory/commitments";
import { isOurs } from "#/inventory/locations";
import { carried, listingEnded } from "#/products/archive";
import { ReturnError, receiveReturn } from "./returns";

// Refurbished one-offs, made from a returned unit at the bench: a draft in
// Shopify (condition in metafield custom.condition, which the theme shows)
// and a product here, linked, with the returned units as its stock. The
// draft copies everything about the original but its photos; what may
// differ for this unit is chosen in the dialog first. Its SKU, which is
// also its barcode in both places, is "<SKU>-RFB<n>", used nowhere else. Its
// cost is what the unit cost when it sold, so the order it came back from
// isn't charged for it and its own sale is. A refurb of the same thing in
// the same condition can take more units instead. Retired once sold out
// (src/orders/refurb-retire.ts).

// What may differ for this unit, set in the dialog. Everything else is
// copied from the original's Shopify listing.
export type RefurbDetails = {
	condition: string;
	title: string;
	price: number;
	compareAtPrice: number | null;
	weightGrams: number | null;
	vendor: string;
	productType: string;
	tags: string[];
	// About this unit, for its page and its label.
	notes: string;
};

// What the refurb dialog starts from.
export type RefurbishOptions = {
	original: { sku: string; name: string };
	conditions: Condition[];
	// Every tag in the shop, to suggest.
	shopTags: string[];
	// The dialog's fields as the original has them; condition left to choose.
	details: Omit<RefurbDetails, "condition">;
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
	return { line, ...(await originalProduct(db, line.productId)) };
}

// The product a refurb is made from, and its live Shopify listing, to copy
// the product's page from.
export async function originalProduct(db: Db, productId: number) {
	const [product] = await db
		.select()
		.from(products)
		.where(eq(products.id, productId));
	if (!product) throw new ReturnError("No such product");
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
	return { product, listing: listing ?? null };
}

// The next "<SKU>-RFB<n>" that's nobody's SKU, barcode or alias here, no
// listing's SKU on any channel, and no SKU or barcode in Shopify.
async function nextRefurbSku(db: Db, base: string) {
	const prefix = `${base}-RFB`.toLowerCase();
	const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const taken = await db
		.select({ sku: products.sku })
		.from(products)
		.where(sql`lower(${products.sku}) like ${pattern}`)
		.union(
			db
				.select({ sku: sql<string>`${products.barcode}` })
				.from(products)
				.where(sql`lower(${products.barcode}) like ${pattern}`),
		)
		.union(
			db
				.select({ sku: productAliases.alias })
				.from(productAliases)
				.where(sql`lower(${productAliases.alias}) like ${pattern}`),
		)
		.union(
			db
				.select({ sku: sql<string>`${listings.externalSku}` })
				.from(listings)
				.where(sql`lower(${listings.externalSku}) like ${pattern}`),
		);
	const used = new Set(taken.map((t) => t.sku.toLowerCase()));
	for (let n = 1; ; n++) {
		const sku = `${base}-RFB${n}`;
		if (used.has(sku.toLowerCase())) continue;
		if (await shopifySkuTaken(sku)) continue;
		return { sku, n };
	}
}

// What Google Shopping is told for a condition: worn ones are used, the
// rest refurbished, unless it's new.
export function googleCondition(handle: string) {
	if (handle.startsWith("new")) return "new";
	return handle === "good" || handle === "poor" ? "used" : "refurbished";
}

// Grams in a Shopify weight.
const GRAMS = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.3495, POUNDS: 453.592 };
function gramsOf(shop: ShopifyOriginal | null) {
	const weight = shop?.inventoryItem.measurement.weight;
	if (!weight || weight.value <= 0) return null;
	const per = GRAMS[weight.unit as keyof typeof GRAMS];
	return per ? Math.round(weight.value * per) : null;
}

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

// What a refurb starts as: of a returned line, or of a product (a bench
// job's tool, bought in), priced at what it sells for new.
export async function refurbishOptions(
	db: Db,
	input: { orderId: number; lineId: number } | { productId: number },
): Promise<RefurbishOptions> {
	const { line, product, listing } =
		"productId" in input
			? {
					...(await originalProduct(db, input.productId)),
					line: null,
				}
			: await originalOf(db, input.orderId, input.lineId);
	const [shop, conditions, shopTags, { sku }, existing] = await Promise.all([
		listing ? shopifyOriginal(listing.variantId) : null,
		shopifyConditions(),
		shopifyTags(),
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
		shopTags,
		details: {
			title: shop?.product.title ?? product.name,
			price: shop ? Number(shop.price) : (line?.unitPrice ?? 0),
			// What it costs new, so the listing shows the saving once the
			// price comes down.
			compareAtPrice: shop ? Number(shop.price) : (line?.unitPrice ?? null),
			weightGrams: gramsOf(shop) ?? product.weightGrams,
			vendor: shop?.product.vendor ?? "",
			productType: shop?.product.productType ?? "",
			tags: shop?.product.tags ?? [],
			notes: "",
		},
		sku,
		existing,
	};
}

// The listing a refurb's details make, checked: its Shopify condition.
async function checkedCondition(input: RefurbDetails) {
	if (!input.title.trim()) throw new ReturnError("Give it a title");
	if (!(input.price > 0)) throw new ReturnError("Give it a price");
	if (input.compareAtPrice !== null && !(input.compareAtPrice > input.price))
		throw new ReturnError("A compare-at price is more than the price");
	const condition = (await shopifyConditions()).find(
		(c) => c.handle === input.condition,
	);
	if (!condition)
		throw new ReturnError(`Shopify has no condition "${input.condition}"`);
	return condition;
}

type Original = Awaited<ReturnType<typeof originalProduct>>;

// Makes a refurb of `original`: its Shopify draft and its product here,
// linked, then runs `receive` to put its units on the shelf. Run inside a
// transaction. The draft is made holding the original product's row, so two
// people can't make the same SKU at once; if anything fails after it,
// `receive` included, the draft is deleted again and nothing is left half
// made.
export async function makeRefurb<T>(
	tx: Db,
	input: {
		original: Original;
		details: RefurbDetails;
		quantity: number;
		unitCost: number | null;
	},
	receive: (refurbId: number) => Promise<T>,
) {
	const { product, listing } = input.original;
	const condition = await checkedCondition(input.details);
	const title = input.details.title.trim();
	const shop = listing ? await shopifyOriginal(listing.variantId) : null;
	const [store] = listing
		? [{ id: listing.storeId }]
		: await tx
				.select({ id: stores.id })
				.from(stores)
				.where(eq(stores.channel, "shopify"))
				.orderBy(asc(stores.id))
				.limit(1);
	if (!store) throw new ReturnError("No Shopify store is synced yet");
	await tx
		.select({ id: products.id })
		.from(products)
		.where(eq(products.id, product.id))
		.for("update");
	const { sku, n } = await nextRefurbSku(tx, product.sku);
	const d = input.details;
	const draft = await createRefurbDraft(shop, {
		handle: `${shop?.product.handle ?? slug(title)}-refurbished-${n}`,
		title,
		vendor: d.vendor.trim(),
		productType: d.productType.trim(),
		tags: d.tags.map((t) => t.trim()).filter(Boolean),
		conditionId: condition.id,
		googleCondition: googleCondition(condition.handle),
		notes: d.notes,
		sku,
		price: d.price,
		compareAtPrice: d.compareAtPrice,
		unitCost: input.unitCost,
		weightGrams: d.weightGrams,
		quantity: input.quantity,
	});
	try {
		const [refurb] = await tx
			.insert(products)
			.values({
				sku,
				barcode: sku,
				name: title,
				kind: "simple",
				refurbishedFromId: product.id,
				condition: condition.handle,
				notes: d.notes.trim() || null,
				unitCost: input.unitCost,
				category: product.category,
				weightGrams: d.weightGrams ?? product.weightGrams,
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
			vendor: d.vendor.trim() || null,
			productType: d.productType.trim() || null,
			productId: refurb.id,
		});
		const received = await receive(refurb.id);
		return {
			received,
			sku,
			productId: refurb.id,
			shopifyUrl: shopifyAdminProductUrl(draft.productId),
		};
	} catch (error) {
		await deleteShopifyVariant(draft.variantId).catch(() => {});
		throw error;
	}
}

// Makes the refurb and receives the line's units into it, at what the unit
// cost when it sold.
export async function refurbishReturn(
	db: Db,
	input: {
		orderId: number;
		lineId: number;
		quantity: number;
		returnNote?: string | null;
	} & RefurbDetails,
) {
	await checkedCondition(input);
	const original = await originalOf(db, input.orderId, input.lineId);
	const unitCost = original.line.unitCost ?? original.product.unitCost;
	return db.transaction(async (tx) => {
		await readQuantityMode(tx);
		await tx
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.id, input.orderId))
			.for("no key update");
		const made = await makeRefurb(
			tx,
			{ original, details: input, quantity: input.quantity, unitCost },
			(refurbId) =>
				receiveReturn(tx, {
					orderId: input.orderId,
					lines: [{ lineId: input.lineId, quantity: input.quantity }],
					outcome: { refurbishInto: refurbId },
					note: input.returnNote,
				}),
		);
		const { received, ...rest } = made;
		return { ids: received.ids, ...rest };
	});
}
