import { type } from "arktype";
import { shopifyQuery } from "./client";

const shippedPage = type({
	order: {
		fulfillments: type({
			status: "string",
			fulfillmentLineItems: {
				nodes: type({
					quantity: "number.integer",
					lineItem: { id: "string" },
				}).array(),
			},
		}).array(),
	},
});

const SHIPPED_QUERY = `
query Shipped($id: ID!) {
	order(id: $id) {
		fulfillments(first: 10) {
			status
			fulfillmentLineItems(first: 50) { nodes { quantity lineItem { id } } }
		}
	}
}`;

// Fulfillments that never went out.
const notShipped = new Set(["CANCELLED", "ERROR", "FAILURE"]);

// Units of each line that have shipped, by line ID.
export async function shippedUnits(orderId: string) {
	const page = shippedPage.assert(
		await shopifyQuery(SHIPPED_QUERY, { id: orderId }),
	);
	const shipped = new Map<string, number>();
	for (const f of page.order.fulfillments) {
		if (notShipped.has(f.status)) continue;
		for (const item of f.fulfillmentLineItems.nodes) {
			const id = item.lineItem.id;
			shipped.set(id, (shipped.get(id) ?? 0) + item.quantity);
		}
	}
	return shipped;
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
