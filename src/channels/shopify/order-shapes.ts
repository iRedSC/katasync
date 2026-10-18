import { type } from "arktype";

export const money = type({ shopMoney: { amount: "string.numeric.parse" } });

export const orderNode = type({
	id: "string",
	name: "string",
	sourceName: "string | null",
	tags: "string[]",
	app: type({ name: "string" }).or("null"),
	channelInformation: type({
		channelDefinition: type({ channelName: "string" }).or("null"),
	}).or("null"),
	createdAt: "string.date.iso.parse",
	updatedAt: "string.date.iso.parse",
	cancelledAt: "string.date.iso.parse | null",
	displayFulfillmentStatus: "string",
	displayFinancialStatus: "string | null",
	totalPriceSet: money,
	totalShippingPriceSet: money,
	shippingAddress: type({
		name: "string | null",
		address1: "string | null",
		address2: "string | null",
		city: "string | null",
		provinceCode: "string | null",
		zip: "string | null",
		countryCodeV2: "string | null",
		phone: "string | null",
	}).or("null"),
	lineItems: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: type({
			id: "string",
			sku: "string | null",
			name: "string",
			quantity: "number.integer",
			currentQuantity: "number.integer",
			variant: type({ id: "string" }).or("null"),
			discountedUnitPriceAfterAllDiscountsSet: money,
		}).array(),
	},
});

export const ordersPage = type({
	orders: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: orderNode.array(),
	},
});

export const ORDER_FIELDS = `
	id name createdAt updatedAt cancelledAt sourceName tags
	app { name }
	channelInformation { channelDefinition { channelName } }
	displayFulfillmentStatus displayFinancialStatus
	totalPriceSet { shopMoney { amount } }
	totalShippingPriceSet { shopMoney { amount } }
	shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 phone }
	lineItems(first: 30) {
		pageInfo { hasNextPage endCursor }
		nodes {
			id sku name quantity currentQuantity
			variant { id }
			discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
		}
	}`;

export const ORDERS_QUERY = `
query Orders($cursor: String, $query: String) {
	orders(first: 25, after: $cursor, sortKey: UPDATED_AT, query: $query) {
		pageInfo { hasNextPage endCursor }
		nodes { ${ORDER_FIELDS} }
	}
}`;

export type ShopifyOrder = typeof orderNode.infer;
