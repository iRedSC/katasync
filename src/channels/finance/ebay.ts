import { type } from "arktype";
import type { ReportedCharge } from "#/orders/charges";
import { type ChargeFetcher, eachOrder } from "#/orders/cost-refresh";
import { accessToken } from "../ebay";

// What eBay charged on an order, from the Finances API: selling fees on the
// sale, labels bought on eBay, ad fees, refunds, and anything else posted
// against the order. Each transaction says whether it took money (DEBIT) or
// gave some back (CREDIT), so a refunded fee or a voided label nets out.

// Finances lives on its own host.
const FINANCES = "https://apiz.ebay.com/sell/finances/v1/transaction";
const PAGE = 200;

const money = type({ value: "string.numeric.parse" });
const transaction = type({
	transactionType: "string",
	bookingEntry: "'CREDIT' | 'DEBIT'",
	amount: money,
	"totalFeeAmount?": money,
	"transactionMemo?": "string",
	"orderLineItems?": type({
		"marketplaceFees?": type({ feeType: "string", amount: money }).array(),
	}).array(),
});
const page = type({ "transactions?": transaction.array() });

export type EbayTransaction = typeof transaction.infer;

// Money movements that aren't about the order's profit.
const IGNORED = new Set(["PAYOUT", "TRANSFER", "WITHDRAWAL", "LOAN_REPAYMENT"]);

// "FINAL_VALUE_FEE_FIXED_PER_ORDER" → "Final value fee fixed per order".
export function words(code: string) {
	const text = code.toLowerCase().replaceAll("_", " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function lineFees(t: EbayTransaction) {
	return (t.orderLineItems ?? []).flatMap((l) => l.marketplaceFees ?? []);
}

export function ebayCharges(transactions: EbayTransaction[]): ReportedCharge[] {
	const charges: ReportedCharge[] = [];
	for (const t of transactions) {
		if (IGNORED.has(t.transactionType)) continue;
		// Positive when it cost us.
		const sign = t.bookingEntry === "DEBIT" ? 1 : -1;
		const amount = t.amount.value;
		const fees = lineFees(t);
		const feeTotal = t.totalFeeAmount?.value ?? 0;
		switch (t.transactionType) {
			case "SALE":
				// The sale's own amount is revenue, already on the order; only its
				// fees are charges.
				for (const f of fees) {
					charges.push({
						kind: "fee",
						description: words(f.feeType),
						amount: f.amount.value,
					});
				}
				if (fees.length === 0 && feeTotal !== 0) {
					charges.push({
						kind: "fee",
						description: "Selling fees",
						amount: feeTotal,
					});
				}
				break;
			case "REFUND":
				// eBay hands back the fees on what's refunded, so the debit is the
				// refund less those fees. Both are kept, and they add up to it.
				charges.push({
					kind: "refund",
					description: t.transactionMemo ?? "Refund",
					amount: sign * (amount + feeTotal),
				});
				for (const f of fees) {
					charges.push({
						kind: "fee",
						description: `${words(f.feeType)} refunded`,
						amount: -sign * f.amount.value,
					});
				}
				if (fees.length === 0 && feeTotal !== 0) {
					charges.push({
						kind: "fee",
						description: "Selling fees refunded",
						amount: -sign * feeTotal,
					});
				}
				break;
			case "SHIPPING_LABEL":
				charges.push({
					kind: "label",
					description:
						sign > 0 ? "eBay shipping label" : "eBay shipping label refunded",
					amount: sign * amount,
				});
				break;
			case "NON_SALE_CHARGE":
				charges.push({
					kind: "fee",
					description: t.transactionMemo ?? "eBay charge",
					amount: sign * amount,
				});
				break;
			default:
				// Disputes, credits, and adjustments eBay posts against the order.
				charges.push({
					kind: "adjustment",
					description: t.transactionMemo ?? words(t.transactionType),
					amount: sign * amount,
				});
		}
	}
	return charges;
}

export async function ebayTransactions(orderId: string) {
	const all: EbayTransaction[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const url = new URL(FINANCES);
		url.search = new URLSearchParams({
			filter: `orderId:{${orderId}}`,
			limit: String(PAGE),
			offset: String(offset),
		}).toString();
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${await accessToken()}` },
		});
		if (!response.ok) {
			throw new Error(
				`eBay Finances answered ${response.status}: ${await response.text()}`,
			);
		}
		const transactions = page.assert(await response.json()).transactions ?? [];
		all.push(...transactions);
		if (transactions.length < PAGE) return all;
	}
}

// eBay posts the sale's transaction once the buyer has paid; nothing posted
// yet means nothing to report yet.
export const fetchEbayCharges: ChargeFetcher = eachOrder(async (order) => {
	const transactions = await ebayTransactions(order.marketplaceId);
	if (transactions.length === 0) return null;
	return { settled: false, charges: ebayCharges(transactions) };
});
