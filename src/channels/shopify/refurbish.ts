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

const originalRead = type({
	productVariant: type({
		price: "string",
		product: {
			id: "string",
			handle: "string",
			title: "string",
			descriptionHtml: "string",
			vendor: "string",
			productType: "string",
		},
	}).or("null"),
});

export type ShopifyOriginal = NonNullable<
	(typeof originalRead.infer)["productVariant"]
>;

// The product a variant belongs to, to make its refurb from.
export async function shopifyOriginal(
	variantId: string,
): Promise<ShopifyOriginal | null> {
	const { productVariant } = originalRead.assert(
		await shopifyQuery(
			`query($id: ID!) { productVariant(id: $id) { price product { id handle title descriptionHtml vendor productType } } }`,
			{ id: variantId },
		),
	);
	return productVariant;
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

// Makes the refurb's product as a draft with its stock at the primary
// location (where stock push sets it). Keyed by handle, so trying again
// after a failure updates the same draft instead of making another.
export async function createRefurbDraft(input: {
	handle: string;
	title: string;
	descriptionHtml: string;
	vendor: string;
	productType: string;
	conditionId: string;
	sku: string;
	price: number;
	unitCost: number | null;
	quantity: number;
}): Promise<{ productId: string; variantId: string }> {
	const { locations } = primaryRead.assert(
		await shopifyQuery(
			"{ locations(first: 50) { nodes { id isPrimary } } }",
			{},
		),
	);
	const primary = locations.nodes.find((l) => l.isPrimary);
	if (!primary) throw new Error("Shopify has no primary location");
	const { productSet } = productSetResult.assert(
		await shopifyQuery(
			`mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
				productSet(input: $input, identifier: $identifier, synchronous: true) {
					product { id variants(first: 1) { nodes { id } } }
					userErrors { field message }
				}
			}`,
			{
				identifier: { handle: input.handle },
				input: {
					handle: input.handle,
					title: input.title,
					descriptionHtml: input.descriptionHtml,
					vendor: input.vendor,
					productType: input.productType,
					status: "DRAFT",
					metafields: [
						{
							namespace: "custom",
							key: "condition",
							type: "metaobject_reference",
							value: input.conditionId,
						},
					],
					productOptions: [
						{ name: "Title", values: [{ name: "Default Title" }] },
					],
					variants: [
						{
							optionValues: [{ optionName: "Title", name: "Default Title" }],
							sku: input.sku,
							price: input.price.toFixed(2),
							inventoryItem: {
								tracked: true,
								...(input.unitCost !== null && {
									cost: input.unitCost.toFixed(2),
								}),
							},
							inventoryQuantities: [
								{
									locationId: primary.id,
									name: "available",
									quantity: input.quantity,
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
