import { type } from "arktype";
import { shopifyQuery } from "./client";

const shippedPage = type({
	order: {
		fulfillments: type({
			status: "string",
			fulfillmentLineItems: {
				pageInfo: { hasNextPage: "boolean" },
				nodes: type({
					quantity: "number.integer",
					lineItem: { id: "string" },
				}).array(),
			},
		}).array(),
	},
});

// Order.fulfillments is a plain list, not a page: asking for this many and
// getting them all back means there may be more.
const MOST_FULFILLMENTS = 50;

const SHIPPED_QUERY = `
query Shipped($id: ID!) {
	order(id: $id) {
		fulfillments(first: ${MOST_FULFILLMENTS}) {
			status
			fulfillmentLineItems(first: 250) { pageInfo { hasNextPage } nodes { quantity lineItem { id } } }
		}
	}
}`;

// Fulfillments that never went out.
const notShipped = new Set(["CANCELLED", "ERROR", "FAILURE"]);

export type ShippedUnits = {
	// Units of each line in any fulfillment that didn't fail, by line ID:
	// what line quantities count as gone (shopifyLineQuantity).
	sent: Map<string, number>;
	// Only those in successful fulfillments: what the order shows shipped.
	succeeded: Map<string, number>;
};

// Units of each line that have shipped, or null when the order has more
// fulfillments or lines than one read returns, so a short count is never
// taken for the whole.
export async function shippedUnits(
	orderId: string,
): Promise<ShippedUnits | null> {
	const page = shippedPage.assert(
		await shopifyQuery(SHIPPED_QUERY, { id: orderId }),
	);
	const { fulfillments } = page.order;
	if (
		fulfillments.length >= MOST_FULFILLMENTS ||
		fulfillments.some((f) => f.fulfillmentLineItems.pageInfo.hasNextPage)
	)
		return null;
	const units: ShippedUnits = { sent: new Map(), succeeded: new Map() };
	const add = (to: Map<string, number>, id: string, n: number) =>
		to.set(id, (to.get(id) ?? 0) + n);
	for (const f of fulfillments) {
		if (notShipped.has(f.status)) continue;
		for (const item of f.fulfillmentLineItems.nodes) {
			add(units.sent, item.lineItem.id, item.quantity);
			if (f.status === "SUCCESS")
				add(units.succeeded, item.lineItem.id, item.quantity);
		}
	}
	return units;
}

const remainingOrdersPage = type({
	order: {
		fulfillmentOrders: {
			pageInfo: { hasNextPage: "boolean", endCursor: "string | null" },
			nodes: type({ id: "string", status: "string" }).array(),
		},
	},
});

const remainingItemsPage = type({
	node: {
		lineItems: {
			pageInfo: { hasNextPage: "boolean", endCursor: "string | null" },
			nodes: type({
				remainingQuantity: "number.integer >= 0",
				lineItem: { id: "string" },
			}).array(),
		},
	},
});

export async function remainingUnits(orderId: string) {
	const remaining = new Map<string, number>();
	let orderCursor: string | null = null;
	do {
		const { order } = remainingOrdersPage.assert(
			await shopifyQuery(
				`query($id: ID!, $cursor: String) {
				order(id: $id) { fulfillmentOrders(first: 50, after: $cursor) {
					pageInfo { hasNextPage endCursor } nodes { id status }
				} }
			}`,
				{ id: orderId, cursor: orderCursor },
			),
		);
		for (const fulfillment of order.fulfillmentOrders.nodes) {
			if (fulfillment.status === "CANCELLED" || fulfillment.status === "CLOSED")
				continue;
			let lineCursor: string | null = null;
			do {
				const { node } = remainingItemsPage.assert(
					await shopifyQuery(
						`query($id: ID!, $cursor: String) {
						node(id: $id) { ... on FulfillmentOrder { lineItems(first: 100, after: $cursor) {
							pageInfo { hasNextPage endCursor } nodes { remainingQuantity lineItem { id } }
						} } }
					}`,
						{ id: fulfillment.id, cursor: lineCursor },
					),
				);
				for (const item of node.lineItems.nodes) {
					const id = item.lineItem.id;
					remaining.set(id, (remaining.get(id) ?? 0) + item.remainingQuantity);
				}
				lineCursor = node.lineItems.pageInfo.hasNextPage
					? node.lineItems.pageInfo.endCursor
					: null;
				if (node.lineItems.pageInfo.hasNextPage && !lineCursor)
					throw new Error("Shopify omitted the remaining-items cursor");
			} while (lineCursor);
		}
		orderCursor = order.fulfillmentOrders.pageInfo.hasNextPage
			? order.fulfillmentOrders.pageInfo.endCursor
			: null;
		if (order.fulfillmentOrders.pageInfo.hasNextPage && !orderCursor)
			throw new Error("Shopify omitted the fulfillment-orders cursor");
	} while (orderCursor);
	return remaining;
}
