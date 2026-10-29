import { type } from "arktype";
import { shopifyQuery, userErrors } from "./client";

// Draft orders, which repairs are billed on (src/repairs/draft-sync.ts).
// Needs the read_draft_orders and write_draft_orders scopes.

const money = type({ amount: "string" });

export const draftLine = type({
	uuid: "string",
	title: "string",
	quantity: "number",
	custom: "boolean",
	sku: "string | null",
	taxable: "boolean",
	requiresShipping: "boolean",
	variant: type({ id: "string" }).or("null"),
	originalUnitPriceSet: { shopMoney: money },
	discountedTotalSet: { shopMoney: money },
	priceOverride: type({ amount: "string", currencyCode: "string" }).or("null"),
	appliedDiscount: type({
		title: "string | null",
		description: "string | null",
		value: "number",
		valueType: "'FIXED_AMOUNT' | 'PERCENTAGE'",
	}).or("null"),
	customAttributes: type({ key: "string", value: "string | null" }).array(),
	weight: type({ unit: "string", value: "number" }).or("null"),
});
export type DraftLine = typeof draftLine.infer;

const draftShape = type({
	id: "string",
	name: "string",
	status: "'OPEN' | 'INVOICE_SENT' | 'COMPLETED'",
	invoiceSentAt: "string | null",
	order: type({ id: "string", name: "string" }).or("null"),
	subtotalPriceSet: { shopMoney: money },
	totalTaxSet: { shopMoney: money },
	totalShippingPriceSet: { shopMoney: money },
	totalPriceSet: { shopMoney: money },
	// More lines than one page holds: reading it again would drop the rest.
	lineItems: { pageInfo: { hasNextPage: "boolean" }, nodes: draftLine.array() },
});
export type Draft = typeof draftShape.infer;

const DRAFT_FIELDS = `
	id name status invoiceSentAt
	order { id name }
	subtotalPriceSet { shopMoney { amount } }
	totalTaxSet { shopMoney { amount } }
	totalShippingPriceSet { shopMoney { amount } }
	totalPriceSet { shopMoney { amount } }
	lineItems(first: 250) { pageInfo { hasNextPage } nodes {
		uuid title quantity custom sku taxable requiresShipping
		variant { id }
		originalUnitPriceSet { shopMoney { amount } }
		discountedTotalSet { shopMoney { amount } }
		priceOverride { amount currencyCode }
		appliedDiscount { title description value valueType }
		customAttributes { key value }
		weight { unit value }
	} }`;

// The draft, or null once it's gone from Shopify (deleted there).
export async function readDraft(id: string): Promise<Draft | null> {
	const data = type({ draftOrder: draftShape.or("null") }).assert(
		await shopifyQuery(
			`query($id: ID!) { draftOrder(id: $id) { ${DRAFT_FIELDS} } }`,
			{ id },
		),
	);
	return data.draftOrder;
}

// Where each draft stands, for many at once. A draft deleted in Shopify is
// left out.
export async function draftStatuses(ids: string[]) {
	if (ids.length === 0) return [];
	const data = type({
		nodes: type({
			"id?": "string",
			"status?": "'OPEN' | 'INVOICE_SENT' | 'COMPLETED'",
			"order?": type({ id: "string", name: "string" }).or("null"),
		})
			.or("null")
			.array(),
	}).assert(
		await shopifyQuery(
			`query($ids: [ID!]!) { nodes(ids: $ids) { ... on DraftOrder { id status order { id name } } } }`,
			{ ids },
		),
	);
	return data.nodes.flatMap((n) =>
		n?.id && n.status
			? [{ id: n.id, status: n.status, order: n.order ?? null }]
			: [],
	);
}

export type DraftInput = {
	customerId?: string;
	note?: string;
	tags?: string[];
	lineItems?: Record<string, unknown>[];
};

const changed = type({ draftOrder: draftShape.or("null"), userErrors });
const created = type({ draftOrderCreate: changed });
const updated = type({ draftOrderUpdate: changed });

function answer(r: typeof changed.infer) {
	if (r.userErrors.length > 0 || !r.draftOrder)
		throw new Error(
			`Shopify refused the draft order: ${r.userErrors.map((e) => e.message).join("; ") || "no draft returned"}`,
		);
	return r.draftOrder;
}

const toInput = ({ customerId, ...rest }: DraftInput) => ({
	...rest,
	...(customerId && { purchasingEntity: { customerId } }),
});

export async function createDraft(input: DraftInput) {
	const data = created.assert(
		await shopifyQuery(
			`mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { ${DRAFT_FIELDS} } userErrors { field message } } }`,
			{ input: toInput(input) },
		),
	);
	return answer(data.draftOrderCreate);
}

export async function updateDraft(id: string, input: DraftInput) {
	const data = updated.assert(
		await shopifyQuery(
			`mutation($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) { draftOrder { ${DRAFT_FIELDS} } userErrors { field message } } }`,
			{ id, input: toInput(input) },
		),
	);
	return answer(data.draftOrderUpdate);
}

export async function deleteDraft(id: string) {
	const data = type({
		draftOrderDelete: { deletedId: "string | null", userErrors },
	}).assert(
		await shopifyQuery(
			"mutation($id: ID!) { draftOrderDelete(input: { id: $id }) { deletedId userErrors { field message } } }",
			{ id },
		),
	);
	const errors = data.draftOrderDelete.userErrors;
	if (errors.length > 0)
		throw new Error(
			`Shopify didn't delete the draft order: ${errors.map((e) => e.message).join("; ")}`,
		);
}

// Emails the customer the invoice with its pay link, to the address on
// the draft's customer.
export async function sendDraftInvoice(id: string) {
	const data = type({
		draftOrderInvoiceSend: {
			draftOrder: type({ id: "string" }).or("null"),
			userErrors,
		},
	}).assert(
		await shopifyQuery(
			"mutation($id: ID!) { draftOrderInvoiceSend(id: $id) { draftOrder { id } userErrors { field message } } }",
			{ id },
		),
	);
	const errors = data.draftOrderInvoiceSend.userErrors;
	if (errors.length > 0)
		throw new Error(
			`Shopify didn't send the invoice: ${errors.map((e) => e.message).join("; ")}`,
		);
}

// A draft order's page in Shopify's admin.
export function shopifyAdminDraftUrl(id: string): string | null {
	const handle = process.env.SHOPIFY_STORE_DOMAIN?.replace(
		".myshopify.com",
		"",
	);
	const numeric = id.split("/").pop();
	if (!handle || !numeric) return null;
	return `https://admin.shopify.com/store/${handle}/draft_orders/${encodeURIComponent(numeric)}`;
}

// What a paid repair's order charged, line by line, with the properties
// its draft's lines carried over.
export async function readOrderBill(id: string) {
	const data = type({
		order: type({
			name: "string",
			createdAt: "string",
			subtotalPriceSet: { shopMoney: money },
			totalTaxSet: { shopMoney: money },
			totalShippingPriceSet: { shopMoney: money },
			totalPriceSet: { shopMoney: money },
			totalOutstandingSet: { shopMoney: money },
			totalRefundedSet: { shopMoney: money },
			lineItems: {
				pageInfo: { hasNextPage: "boolean" },
				nodes: type({
					title: "string",
					quantity: "number",
					variant: type({ id: "string" }).or("null"),
					customAttributes: type({
						key: "string",
						value: "string | null",
					}).array(),
					discountedTotalSet: { shopMoney: money },
				}).array(),
			},
		}).or("null"),
	}).assert(
		await shopifyQuery(
			`query($id: ID!) { order(id: $id) {
				name createdAt
				subtotalPriceSet { shopMoney { amount } }
				totalTaxSet { shopMoney { amount } }
				totalShippingPriceSet { shopMoney { amount } }
				totalPriceSet { shopMoney { amount } }
				totalOutstandingSet { shopMoney { amount } }
				totalRefundedSet { shopMoney { amount } }
				lineItems(first: 250) {
					pageInfo { hasNextPage }
					nodes {
						title quantity variant { id } customAttributes { key value }
						discountedTotalSet(withCodeDiscounts: true) { shopMoney { amount } }
					}
				}
			} }`,
			{ id },
		),
	);
	return data.order;
}
