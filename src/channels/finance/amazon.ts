import { type } from "arktype";
import type { ReportedCharge } from "#/orders/charges";
import { type ChargeFetcher, eachOrder } from "#/orders/cost-refresh";
import { MARKETPLACE_US, spApi } from "../amazon-api";

// What Amazon charged on an order, from Finances 2024-06-19 transactions:
// referral and FBA fees on the shipment, labels bought through Amazon
// (PostageBilling), refunds, and adjustments. The older v0 events skip
// shipments Amazon holds back for a week (DD7), so they aren't used.
// Amounts come signed from Amazon's side: negative is what it kept from us.

// Checked all the way down: a nested amount that isn't a number fails the
// order rather than counting as nothing.
const breakdown = type
	.scope({
		breakdown: {
			breakdownType: "string",
			breakdownAmount: { currencyAmount: "number" },
			"breakdowns?": "breakdown[] | null",
		},
	})
	.type("breakdown");
type Breakdown = typeof breakdown.infer;

export const amazonTransaction = type({
	transactionType: "string",
	"transactionStatus?": "string",
	"relatedIdentifiers?": type({
		relatedIdentifierName: "string",
		relatedIdentifierValue: "string",
	})
		.array()
		.or("null"),
	"breakdowns?": breakdown.array().or("null"),
});
const response = type({
	payload: {
		"transactions?": amazonTransaction.array(),
		"nextToken?": "string | null",
	},
});

export type AmazonTransaction = typeof amazonTransaction.infer;

// What a category under Expenses is, as a charge.
const KIND: Record<string, ReportedCharge["kind"]> = {
	AmazonFees: "fee",
	ShippingServiceCharges: "label",
};

// A category's own entries, e.g. AmazonFees' Commission and
// FBAPerUnitFulfillmentFee, or the category itself if it has none.
function entries(category: Breakdown) {
	const children = category.breakdowns ?? [];
	return children.length > 0 ? children : [category];
}

function cost(b: Breakdown) {
	return -b.breakdownAmount.currencyAmount;
}

// Postage Amazon billed, outbound or for a return, whatever category it's
// filed under.
function kindOf(category: Breakdown, entry: Breakdown) {
	if (entry.breakdownType.includes("PostageBilling")) return "label";
	return KIND[category.breakdownType] ?? "adjustment";
}

// Tax Amazon collects and pays itself nets to nothing for us.
const isTax = (b: Breakdown) => b.breakdownType.includes("Tax");
// The order's prices already have its promotion discounts taken off, so a
// shipment's promotions would take them off twice. A refund's are the
// discount coming back to us: Amazon refunds the full price and returns the
// promotion, and only the difference went to the buyer.
const isPromo = (b: Breakdown) => b.breakdownType.includes("Promo");

// Sales on a shipment, "Refunded Sales" on a refund.
const SALES = new Set(["Sales", "Refunded Sales"]);

// What the buyer paid or got back, without the tax Amazon collects and
// refunds itself.
function untaxed(sales: Breakdown) {
	const parts = sales.breakdowns ?? [];
	if (parts.length === 0) return sales.breakdownAmount.currencyAmount;
	return parts
		.filter((p) => !p.breakdownType.includes("Tax"))
		.reduce((sum, p) => sum + p.breakdownAmount.currencyAmount, 0);
}

export function amazonCharges(
	transactions: AmazonTransaction[],
): ReportedCharge[] {
	const charges: ReportedCharge[] = [];
	for (const t of transactions) {
		// A shipment Amazon held back shows up twice once released: the
		// original, and a copy pointing back at it. Only the original counts.
		if (
			t.relatedIdentifiers?.some(
				(r) => r.relatedIdentifierName === "DEFERRED_TRANSACTION_ID",
			)
		)
			continue;
		for (const top of t.breakdowns ?? []) {
			const type = top.breakdownType;
			if (SALES.has(type)) {
				// A sale's own money is revenue, already on the order. On a
				// refund it's what went back to the buyer; on anything else
				// (a reimbursement) it's money back.
				if (t.transactionType === "Shipment") continue;
				const amount = -untaxed(top);
				if (Math.abs(amount) < 0.005) continue;
				const refund = t.transactionType === "Refund";
				charges.push({
					kind: refund ? "refund" : "adjustment",
					description: refund ? "Refund" : t.transactionType,
					amount,
				});
				continue;
			}
			// Tax Amazon collects and pays itself nets to nothing for us.
			if (type.includes("Tax")) continue;
			for (const category of top.breakdowns ?? [top]) {
				if (isTax(category)) continue;
				for (const entry of entries(category)) {
					if (isTax(entry)) continue;
					if (isPromo(category) || isPromo(entry)) {
						if (t.transactionType === "Refund") {
							charges.push({
								kind: "refund",
								description: entry.breakdownType,
								amount: cost(entry),
							});
						}
						continue;
					}
					charges.push({
						kind: kindOf(category, entry),
						description: entry.breakdownType,
						amount: cost(entry),
					});
				}
			}
		}
	}
	return charges;
}

export async function amazonTransactions(orderId: string) {
	const all: AmazonTransaction[] = [];
	let nextToken: string | null | undefined;
	do {
		const query = new URLSearchParams({
			relatedIdentifierName: "ORDER_ID",
			relatedIdentifierValue: orderId,
			marketplaceId: MARKETPLACE_US,
			...(nextToken ? { nextToken } : {}),
		});
		const { payload } = response.assert(
			await spApi(`/finances/2024-06-19/transactions?${query}`),
		);
		all.push(...(payload.transactions ?? []));
		nextToken = payload.nextToken;
	} while (nextToken);
	return all;
}

// Amazon posts a shipment's money when it ships; nothing yet means nothing to
// report yet. It never calls an order's figures final.
export const fetchAmazonCharges: ChargeFetcher = eachOrder(async (order) => {
	const transactions = await amazonTransactions(order.marketplaceId);
	if (transactions.length === 0) return null;
	return { settled: false, charges: amazonCharges(transactions) };
});
