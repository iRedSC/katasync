import { type } from "arktype";
import { shopifyQuery, userErrors } from "./client";

// Shopify's side of refurbished one-offs (src/orders/refurbish.ts): the
// conditions to choose from, the product a refurb is made from, and the
// refurb's own product, made as a draft and archived or deleted later. The
// condition is product metafield custom.condition, a reference to one of the
// shop's "condition" metaobjects, which the theme styles; nothing about it
// goes in the title. Needs read_metaobjects, read_products and
// write_products.

export type Condition = {
	id: string;
	handle: string;
	label: string;
	description: string | null;
	// The shop's color for it, e.g. "#1ea15b".
	color: string | null;
};

const conditionsRead = type({
	metaobjects: {
		nodes: type({
			id: "string",
			handle: "string",
			displayName: "string",
			fields: type({ key: "string", value: "string | null" }).array(),
		}).array(),
	},
});

// The shop's conditions, in the order it lists them.
export async function shopifyConditions(): Promise<Condition[]> {
	const { metaobjects } = conditionsRead.assert(
		await shopifyQuery(
			`{ metaobjects(type: "condition", first: 50) { nodes { id handle displayName fields { key value } } } }`,
			{},
		),
	);
	return metaobjects.nodes.map((m) => {
		const field = (key: string) =>
			m.fields.find((f) => f.key === key)?.value || null;
		return {
			id: m.id,
			handle: m.handle,
			label: field("condition") ?? m.displayName,
			description: field("description"),
			color: field("color"),
		};
	});
}

const metafield = type({
	namespace: "string",
	key: "string",
	type: "string",
	value: "string",
});
type Metafield = typeof metafield.infer;

const originalRead = type({
	productVariant: type({
		price: "string",
		compareAtPrice: "string | null",
		taxable: "boolean",
		inventoryItem: {
			requiresShipping: "boolean",
			harmonizedSystemCode: "string | null",
			countryCodeOfOrigin: "string | null",
			measurement: {
				weight: type({ value: "number", unit: "string" }).or("null"),
			},
		},
		metafields: { nodes: metafield.array() },
		product: {
			handle: "string",
			title: "string",
			descriptionHtml: "string",
			vendor: "string",
			productType: "string",
			tags: "string[]",
			category: type({ id: "string" }).or("null"),
			collections: {
				nodes: type({ id: "string", ruleSet: "object | null" }).array(),
			},
			metafields: { nodes: metafield.array() },
		},
	}).or("null"),
});

export type ShopifyOriginal = NonNullable<
	(typeof originalRead.infer)["productVariant"]
>;

// The product a variant belongs to, to make its refurb from: everything a
// refurb copies, which is all of it but its photos (the refurb gets its
// own, of the unit itself).
export async function shopifyOriginal(
	variantId: string,
): Promise<ShopifyOriginal | null> {
	const { productVariant } = originalRead.assert(
		await shopifyQuery(
			`query($id: ID!) { productVariant(id: $id) {
				price compareAtPrice taxable
				inventoryItem { requiresShipping harmonizedSystemCode countryCodeOfOrigin measurement { weight { value unit } } }
				metafields(first: 50) { nodes { namespace key type value } }
				product {
					handle title descriptionHtml vendor productType tags
					category { id }
					collections(first: 50) { nodes { id ruleSet { appliedDisjunctively } } }
					metafields(first: 100) { nodes { namespace key type value } }
				}
			} }`,
			{ id: variantId },
		),
	);
	return productVariant;
}

const tagsPage = type({
	productTags: {
		nodes: "string[]",
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
	},
});

// Every tag the shop's products use, to suggest while tagging.
export async function shopifyTags(): Promise<string[]> {
	const tags: string[] = [];
	let cursor: string | null = null;
	do {
		const { productTags } = tagsPage.assert(
			await shopifyQuery(
				"query($cursor: String) { productTags(first: 250, after: $cursor) { nodes pageInfo { hasNextPage endCursor } } }",
				{ cursor },
			),
		);
		tags.push(...productTags.nodes);
		cursor = productTags.pageInfo.hasNextPage
			? (productTags.pageInfo.endCursor ?? null)
			: null;
	} while (cursor);
	return tags;
}

const skuRead = type({
	productVariants: { nodes: type({ sku: "string | null" }).array() },
});

// Whether any variant in Shopify, of any product and status, has this SKU or
// barcode.
export async function shopifySkuTaken(sku: string) {
	const quoted = JSON.stringify(sku);
	const { productVariants } = skuRead.assert(
		await shopifyQuery(
			"query($q: String!) { productVariants(first: 5, query: $q) { nodes { sku } } }",
			{ q: `sku:${quoted} OR barcode:${quoted}` },
		),
	);
	return productVariants.nodes.length > 0;
}

const primaryRead = type({
	locations: { nodes: type({ id: "string", isPrimary: "boolean" }).array() },
});

const productSetResult = type({
	productSet: {
		product: type({
			id: "string",
			variants: { nodes: type({ id: "string" }).array() },
		}).or("null"),
		userErrors,
	},
});

const refused = (errors: typeof userErrors.infer) =>
	new Error(`Shopify refused: ${errors.map((e) => e.message).join("; ")}`);

// What's set for the refurb itself, not copied: chosen at the bench.
export type RefurbListing = {
	handle: string;
	title: string;
	vendor: string;
	productType: string;
	tags: string[];
	conditionId: string;
	// What Google Shopping is told.
	googleCondition: "new" | "refurbished" | "used";
	// About this unit, shown on its page (metafield custom.details).
	notes: string;
	sku: string;
	price: number;
	compareAtPrice: number | null;
	unitCost: number | null;
	weightGrams: number | null;
	quantity: number;
};

// Metafields the refurb sets itself, or that belong to another app.
const own = (m: Metafield) =>
	(m.namespace === "custom" &&
		(m.key === "condition" || m.key === "details")) ||
	(m.namespace === "mm-google-shopping" && m.key === "condition") ||
	m.namespace === "bundly" ||
	m.namespace.startsWith("app--");

const GRAMS_PER = {
	GRAMS: 1,
	KILOGRAMS: 1000,
	OUNCES: 28.3495,
	POUNDS: 453.592,
};

// Makes the refurb's product as a draft: a copy of the original (but its
// photos), with what was chosen at the bench, its barcode its SKU, and its
// stock at the primary location (where stock push sets it). Keyed by
// handle, so trying again after a failure updates the same draft instead
// of making another.
export async function createRefurbDraft(
	original: ShopifyOriginal | null,
	r: RefurbListing,
): Promise<{ productId: string; variantId: string }> {
	const { locations } = primaryRead.assert(
		await shopifyQuery(
			"{ locations(first: 50) { nodes { id isPrimary } } }",
			{},
		),
	);
	const primary = locations.nodes.find((l) => l.isPrimary);
	if (!primary) throw new Error("Shopify has no primary location");
	const unit = original?.inventoryItem.measurement.weight?.unit ?? "POUNDS";
	const perUnit = GRAMS_PER[unit as keyof typeof GRAMS_PER] ?? GRAMS_PER.POUNDS;
	const strip = ({ namespace, key, type, value }: Metafield) => ({
		namespace,
		key,
		type,
		value,
	});
	const { productSet } = productSetResult.assert(
		await shopifyQuery(
			`mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
				productSet(input: $input, identifier: $identifier, synchronous: true) {
					product { id variants(first: 1) { nodes { id } } }
					userErrors { field message }
				}
			}`,
			{
				identifier: { handle: r.handle },
				input: {
					handle: r.handle,
					title: r.title,
					descriptionHtml: original?.product.descriptionHtml ?? "",
					vendor: r.vendor,
					productType: r.productType,
					tags: r.tags,
					status: "DRAFT",
					...(original?.product.category && {
						category: original.product.category.id,
					}),
					// Only hand-picked collections take products; rule-based ones
					// pick it up themselves.
					collections: (original?.product.collections.nodes ?? [])
						.filter((c) => c.ruleSet === null)
						.map((c) => c.id),
					metafields: [
						...(original?.product.metafields.nodes ?? [])
							.filter((m) => !own(m))
							.map(strip),
						{
							namespace: "custom",
							key: "condition",
							type: "metaobject_reference",
							value: r.conditionId,
						},
						...(r.notes.trim()
							? [
									{
										namespace: "custom",
										key: "details",
										type: "multi_line_text_field",
										value: r.notes.trim(),
									},
								]
							: []),
					],
					productOptions: [
						{ name: "Title", values: [{ name: "Default Title" }] },
					],
					variants: [
						{
							optionValues: [{ optionName: "Title", name: "Default Title" }],
							sku: r.sku,
							barcode: r.sku,
							price: r.price.toFixed(2),
							compareAtPrice: r.compareAtPrice?.toFixed(2) ?? null,
							taxable: original?.taxable ?? true,
							metafields: [
								...(original?.metafields.nodes ?? [])
									.filter((m) => !own(m))
									.map(strip),
								{
									namespace: "mm-google-shopping",
									key: "condition",
									type: "single_line_text_field",
									value: r.googleCondition,
								},
							],
							inventoryItem: {
								tracked: true,
								requiresShipping:
									original?.inventoryItem.requiresShipping ?? true,
								...(original?.inventoryItem.harmonizedSystemCode && {
									harmonizedSystemCode:
										original.inventoryItem.harmonizedSystemCode,
								}),
								...(original?.inventoryItem.countryCodeOfOrigin && {
									countryCodeOfOrigin:
										original.inventoryItem.countryCodeOfOrigin,
								}),
								...(r.unitCost !== null && { cost: r.unitCost.toFixed(2) }),
								...(r.weightGrams !== null && {
									measurement: {
										weight: {
											value: Math.round((r.weightGrams / perUnit) * 100) / 100,
											unit,
										},
									},
								}),
							},
							inventoryQuantities: [
								{
									locationId: primary.id,
									name: "available",
									quantity: r.quantity,
								},
							],
						},
					],
				},
			},
		),
	);
	if (productSet.userErrors.length > 0) throw refused(productSet.userErrors);
	const variant = productSet.product?.variants.nodes[0];
	if (!productSet.product || !variant)
		throw new Error("Shopify made no product");
	return { productId: productSet.product.id, variantId: variant.id };
}

const productOf = type({
	productVariant: type({ product: { id: "string" } }).or("null"),
});

// The product a variant is on, or null when it's gone from Shopify.
async function productOfVariant(variantId: string) {
	const { productVariant } = productOf.assert(
		await shopifyQuery(
			"query($id: ID!) { productVariant(id: $id) { product { id } } }",
			{ id: variantId },
		),
	);
	return productVariant?.product.id ?? null;
}

const archived = type({ productUpdate: { userErrors } });

// Archives the product a variant is on. Already gone counts as done.
export async function archiveShopifyVariant(variantId: string) {
	const id = await productOfVariant(variantId);
	if (!id) return;
	const { productUpdate } = archived.assert(
		await shopifyQuery(
			"mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }",
			{ product: { id, status: "ARCHIVED" } },
		),
	);
	if (productUpdate.userErrors.length > 0)
		throw refused(productUpdate.userErrors);
}

const deleted = type({ productDelete: { userErrors } });

// Deletes the product a variant is on. Already gone counts as done.
export async function deleteShopifyVariant(variantId: string) {
	const id = await productOfVariant(variantId);
	if (!id) return;
	const { productDelete } = deleted.assert(
		await shopifyQuery(
			"mutation($input: ProductDeleteInput!) { productDelete(input: $input) { userErrors { field message } } }",
			{ input: { id } },
		),
	);
	if (productDelete.userErrors.length > 0)
		throw refused(productDelete.userErrors);
}
