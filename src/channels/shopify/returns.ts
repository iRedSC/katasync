import { type } from "arktype";
import type { ChannelReturn } from "#/orders/return-requests";
import { tiktokOrderId } from "./channel-order";
import { shopifyQuery } from "./client";

// Returns buyers asked for in Shopify, with the reason they picked and
// anything they wrote. Needs the read_returns scope. Shopify also mirrors
// returns on TikTok orders it relayed, reasons and all; those are saved
// against the TikTok order wherever it now lives (by marketplaceOrderId).

// Small pages: Shopify prices a query by the most it could return, and
// refuses one over 1,000.
const RETURNS_QUERY = `query Returns($query: String!, $cursor: String) {
	orders(first: 10, after: $cursor, query: $query, sortKey: UPDATED_AT) {
		pageInfo { hasNextPage endCursor }
		nodes {
			id
			tags
			returns(first: 5) {
				nodes {
					id
					status
					createdAt
					returnLineItems(first: 10) {
						nodes {
							... on ReturnLineItem {
								quantity
								returnReasonNote
								customerNote
								returnReasonDefinition { handle name }
								fulfillmentLineItem { lineItem { id sku } }
							}
						}
					}
					reverseFulfillmentOrders(first: 2) {
						nodes {
							reverseDeliveries(first: 2) {
								nodes {
									deliverable {
										... on ReverseDeliveryShippingDeliverable {
											tracking { number carrierName }
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}
}`;

const returnNode = type({
	id: "string",
	status: "string",
	createdAt: "string.date.iso.parse",
	returnLineItems: {
		nodes: type({
			"quantity?": "number.integer",
			"returnReasonNote?": "string | null",
			"customerNote?": "string | null",
			"returnReasonDefinition?": type({ handle: "string", name: "string" }).or(
				"null",
			),
			"fulfillmentLineItem?": type({
				lineItem: { id: "string", "sku?": "string | null" },
			}).or("null"),
		}).array(),
	},
	reverseFulfillmentOrders: {
		nodes: type({
			reverseDeliveries: {
				nodes: type({
					"deliverable?": type({
						"tracking?": type({
							"number?": "string | null",
							"carrierName?": "string | null",
						}).or("null"),
					}).or("null"),
				}).array(),
			},
		}).array(),
	},
});
export type ShopifyReturn = typeof returnNode.infer;

const ordersPage = type({
	orders: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: type({
			id: "string",
			tags: "string[]",
			returns: { nodes: returnNode.array() },
		}).array(),
	},
});

// Shopify's statuses, as a stage. OPEN only means it was approved; a return
// label's tracking number is the best sign it's on its way.
export function shopifyReturnStatus(
	status: string,
	tracked: boolean,
): ChannelReturn["status"] {
	if (status === "CANCELED" || status === "DECLINED") return "cancelled";
	if (status === "CLOSED") return "closed";
	return tracked ? "shipped" : "requested";
}

// The reason a buyer gave for one item. Shopify files a reason it has no
// definition for under Other, with the buyer's choice in returnReasonNote
// ("No longer needed", "Missing parts"); Unknown means none was given.
export function itemReason(l: {
	returnReasonNote?: string | null;
	returnReasonDefinition?: { handle: string; name: string } | null;
}): string | null {
	const handle = l.returnReasonDefinition?.handle;
	const note = l.returnReasonNote?.trim() || null;
	if (handle === "unknown") return note;
	if (handle === "other-reason" || !handle)
		return note ?? (handle ? "Other" : null);
	return l.returnReasonDefinition?.name ?? note;
}

const joined = (values: (string | null | undefined)[]) => {
	const kept = [...new Set(values.map((v) => v?.trim()).filter(Boolean))];
	return kept.length > 0 ? kept.join("; ") : null;
};

export function shopifyToReturn(
	orderId: string,
	r: ShopifyReturn,
	marketplaceOrderId: string | null = null,
): ChannelReturn {
	const items = r.returnLineItems.nodes.filter((l) => l.quantity);
	const tracking = r.reverseFulfillmentOrders.nodes
		.flatMap((o) => o.reverseDeliveries.nodes)
		.map((d) => d.deliverable?.tracking)
		.find((t) => t?.number);
	return {
		externalId: r.id,
		orderExternalId: orderId,
		marketplaceOrderId,
		status: shopifyReturnStatus(r.status, Boolean(tracking)),
		rawStatus: r.status,
		// Each item has its own reason; a return of several keeps them all.
		reason: joined(items.map(itemReason)),
		note: joined(items.map((l) => l.customerNote)),
		trackingNumber: tracking?.number ?? null,
		carrier: tracking?.carrierName ?? null,
		requestedAt: r.createdAt,
		lines: items.map((l) => ({
			lineExternalId: l.fulfillmentLineItem?.lineItem.id ?? null,
			sku: l.fulfillmentLineItem?.lineItem.sku ?? null,
			quantity: l.quantity ?? 0,
		})),
	};
}

// Returns on orders that changed since `since`. A return being asked for or
// moving along changes its order, so that's enough to catch every update.
export async function fetchShopifyReturns(since: Date, until?: Date) {
	const query = [
		`updated_at:>='${since.toISOString()}'`,
		until ? `updated_at:<'${until.toISOString()}'` : null,
		"-return_status:no_return",
	]
		.filter(Boolean)
		.join(" AND ");
	const returns: ChannelReturn[] = [];
	let cursor: string | null = null;
	do {
		const page = ordersPage.assert(
			await shopifyQuery(RETURNS_QUERY, { query, cursor }),
		);
		for (const o of page.orders.nodes)
			for (const r of o.returns.nodes)
				returns.push(shopifyToReturn(o.id, r, tiktokOrderId(o.tags)));
		cursor = page.orders.pageInfo.hasNextPage
			? (page.orders.pageInfo.endCursor ?? null)
			: null;
	} while (cursor);
	return returns;
}
