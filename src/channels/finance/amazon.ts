import { type } from "arktype";
import type { ReportedCharge } from "#/orders/charges";
import { type ChargeFetcher, eachOrder } from "#/orders/cost-refresh";
import { MARKETPLACE_US, spApi } from "../amazon-api";

// What Amazon charged on an order, from Finances 2024-06-19 transactions:
// referral and FBA fees on the shipment, labels bought through Amazon
// (PostageBilling), refunds, and adjustments. The older v0 events skip
// shipments Amazon holds back for a week (DD7), so they aren't used.
// Amounts come signed from Amazon's side: negative is what it kept from us.

type Breakdown = {
	breakdownType: string;
	breakdownAmount: { currencyAmount: number };
	breakdowns?: Breakdown[] | null;
};
const breakdown = type({
	breakdownType: "string",
	breakdownAmount: { currencyAmount: "number" },
	"breakdowns?": "unknown[] | null",
}).pipe((b) => b as Breakdown);

const transaction = type({
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
		"transactions?": transaction.array(),
		"nextToken?": "string | null",
	},
});

export type AmazonTransaction = typeof transaction.infer;

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
			if (type === "Sales") {
				// A sale's own money is revenue, already on the order. On a
				// refund it's what went back to the buyer; on anything else
				// (a reimbursement) it's money back.
				if (top.breakdownAmount.currencyAmount === 0) continue;
				if (t.transactionType === "Shipment") continue;
				charges.push({
					kind: t.transactionType === "Refund" ? "refund" : "adjustment",
					description:
						t.transactionType === "Refund" ? "Refund" : t.transactionType,
					amount: cost(top),
				});
				continue;
			}
			// Tax Amazon collects and pays itself nets to nothing for us.
			if (type.includes("Tax")) continue;
			for (const category of top.breakdowns ?? [top]) {
				for (const entry of entries(category)) {
					charges.push({
						kind: KIND[category.breakdownType] ?? "adjustment",
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
