import { type } from "arktype";
import type { ReportedCharge } from "#/orders/charges";
import type { ChargeFetcher, DueOrder } from "#/orders/cost-refresh";
import { shopifyQuery } from "../shopify";

// What Shopify charged on orders: payment processing fees and refunds from
// the order itself (posted at once), and Shopify Shipping labels from
// ShopifyQL's shipping_labels report, which also has voids and carrier
// adjustments. ShopifyQL lags the order by up to a day, so until it has an
// order, the label purchases in the order's timeline stand in.
// Orders paid outside Shopify Payments (cash at the counter, a relayed TikTok
// order) have no fees here, and that's right: nobody bills them.

// Order IDs are put into ShopifyQL's text, so they must be digits only.
export function numericOrderId(gid: string) {
	const id = gid.split("/").pop() ?? "";
	if (!/^\d+$/.test(id)) throw new Error(`Not a Shopify order ID: ${gid}`);
	return id;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

// Sale days are the shop's, not UTC, so the window reaches two days early.
export function shippingLabelsQuery(ids: string[], since: Date) {
	const from = new Date(since.getTime() - 2 * 24 * 60 * 60 * 1000);
	return [
		"FROM shipping_labels SHOW shipping_label_costs",
		`WHERE order_id IN (${ids.map(numericOrderId).join(", ")})`,
		"GROUP BY order_id",
		`SINCE ${day(from)} UNTIL today`,
		"ORDER BY order_id ASC",
		`LIMIT ${ids.length}`,
	].join(" ");
}

const LABEL_BOUGHT = /purchased a \$([0-9,]+(?:\.[0-9]+)?)\s+shipping label/i;

export function labelsFromEvents(
	events: { action?: string; message?: string }[],
) {
	let total = 0;
	for (const event of events) {
		if (event.action !== "shipping_label_created_success") continue;
		const match = event.message?.match(LABEL_BOUGHT);
		if (match) total += Number(match[1].replaceAll(",", ""));
	}
	return total;
}

const money = type({ shopMoney: { amount: "string.numeric.parse" } });
const order = type({
	id: "string",
	transactions: type({
		kind: "string",
		status: "string",
		fees: type({
			type: "string",
			amount: { amount: "string.numeric.parse" },
		}).array(),
	}).array(),
	refunds: type({
		refundLineItems: { nodes: type({ subtotalSet: money }).array() },
		refundShippingLines: { nodes: type({ subtotalAmountSet: money }).array() },
	}).array(),
	events: {
		nodes: type({ "action?": "string", "message?": "string" }).array(),
	},
	fulfillmentOrders: {
		nodes: type({
			deliveryMethod: type({ methodType: "string" }).or("null"),
		}).array(),
	},
});
export type ShopifyFinanceOrder = typeof order.infer;

const ORDERS = `query($ids: [ID!]!) {
	nodes(ids: $ids) {
		... on Order {
			id
			transactions(first: 50) { kind status fees { type amount { amount } } }
			refunds(first: 50) {
				refundLineItems(first: 100) { nodes { subtotalSet { shopMoney { amount } } } }
				refundShippingLines(first: 10) { nodes { subtotalAmountSet { shopMoney { amount } } } }
			}
			events(first: 100, query: "action:shipping_label_created_success") {
				nodes { ... on BasicEvent { action message } }
			}
			fulfillmentOrders(first: 20) { nodes { deliveryMethod { methodType } } }
		}
	}
}`;

const SHOPIFYQL = `query($q: String!) {
	shopifyqlQuery(query: $q) { tableData { rows } parseErrors }
}`;
const shopifyql = type({
	shopifyqlQuery: {
		"tableData?": type({
			rows: type({
				order_id: "string | number",
				shipping_label_costs: "string | number",
			}).array(),
		}).or("null"),
		"parseErrors?": "string[] | null",
	},
});

// Picked up, sold at the counter, or driven over ourselves: no label.
const UNSHIPPED = new Set(["PICK_UP", "RETAIL", "NONE", "LOCAL"]);

export function shippedWithoutLabel(o: ShopifyFinanceOrder) {
	const methods = o.fulfillmentOrders.nodes.map(
		(f) => f.deliveryMethod?.methodType ?? "NONE",
	);
	return methods.length > 0 && methods.every((m) => UNSHIPPED.has(m));
}

// "processing_fee" → "Processing fee".
function words(code: string) {
	const text = code.replaceAll("_", " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function shopifyCharges(
	o: ShopifyFinanceOrder,
	reportedLabels: number | undefined,
): ReportedCharge[] {
	const charges: ReportedCharge[] = [];
	for (const t of o.transactions) {
		if (t.status !== "SUCCESS") continue;
		// Fees on a refund transaction are Shopify giving some back.
		const sign = t.kind === "REFUND" ? -1 : 1;
		for (const f of t.fees) {
			charges.push({
				kind: "fee",
				description: words(f.type),
				amount: sign * f.amount.amount,
			});
		}
	}
	for (const r of o.refunds) {
		// What went back to the buyer, without the tax Shopify returns for us.
		const refunded =
			r.refundLineItems.nodes.reduce(
				(s, l) => s + l.subtotalSet.shopMoney.amount,
				0,
			) +
			r.refundShippingLines.nodes.reduce(
				(s, l) => s + l.subtotalAmountSet.shopMoney.amount,
				0,
			);
		if (refunded !== 0) {
			charges.push({ kind: "refund", description: "Refund", amount: refunded });
		}
	}
	const labels = reportedLabels ?? labelsFromEvents(o.events.nodes);
	if (labels !== 0) {
		charges.push({
			kind: "label",
			description:
				reportedLabels === undefined
					? "Shopify Shipping labels (until Shopify reports them)"
					: "Shopify Shipping labels",
			amount: labels,
		});
	}
	return charges;
}

export const fetchShopifyCharges: ChargeFetcher = async (due: DueOrder[]) => {
	const results = [];
	// ShopifyQL takes up to 50 order IDs a query.
	for (let i = 0; i < due.length; i += 50) {
		const batch = due.slice(i, i + 50);
		const since = new Date(Math.min(...batch.map((o) => o.placedAt.getTime())));
		const [ordersBody, labelsBody] = await Promise.all([
			shopifyQuery(ORDERS, { ids: batch.map((o) => o.marketplaceId) }),
			shopifyQuery(SHOPIFYQL, {
				q: shippingLabelsQuery(
					batch.map((o) => o.marketplaceId),
					since,
				),
			}),
		]);
		const { shopifyqlQuery } = shopifyql.assert(labelsBody);
		if (shopifyqlQuery.parseErrors?.length) {
			throw new Error(`ShopifyQL: ${shopifyqlQuery.parseErrors.join("; ")}`);
		}
		const labels = new Map(
			(shopifyqlQuery.tableData?.rows ?? []).map((r) => [
				String(r.order_id),
				Number(r.shipping_label_costs),
			]),
		);
		const nodes = type({ nodes: "unknown[]" }).assert(ordersBody).nodes;
		for (const [j, o] of batch.entries()) {
			const node = nodes[j];
			if (!node) {
				results.push({
					orderId: o.orderId,
					error: "Shopify has no such order",
				});
				continue;
			}
			const parsed = order(node);
			if (parsed instanceof type.errors) {
				results.push({ orderId: o.orderId, error: parsed.summary });
				continue;
			}
			results.push({
				orderId: o.orderId,
				report: {
					settled: false,
					noLabel: shippedWithoutLabel(parsed),
					charges: shopifyCharges(
						parsed,
						labels.get(numericOrderId(o.marketplaceId)),
					),
				},
			});
		}
	}
	return results;
};
