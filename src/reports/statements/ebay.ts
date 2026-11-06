import { type } from "arktype";
import { accessToken } from "#/channels/ebay";
import { words } from "#/channels/finance/ebay";
import {
	cents,
	type Statement,
	type StatementLine,
	sectionTotal,
} from "./types";
import type { MonthWindow } from "./window";

// eBay's monthly financial statement, from the Finances API's transactions
// dated in the month (Pacific time): a sale nets its fees, a refund nets the
// fees eBay gave back, as the statement's lines do.

const FINANCES = "https://apiz.ebay.com/sell/finances/v1/transaction";
const PAGE = 200;
// eBay sometimes leaves part of a range out of one answer and has it the next
// time (src/payouts/ebay.ts), so the month is asked this many times and the
// answers put together by transaction ID. A transaction appears once however
// many answers have it, so asking again can only fill gaps.
const ASKS = 2;

const money = type({ value: "string.numeric.parse" });
export const ebayStatementTransaction = type({
	transactionId: "string",
	transactionType: "string",
	bookingEntry: "'CREDIT' | 'DEBIT'",
	amount: money,
	"totalFeeAmount?": money,
	"ebayCollectedTaxAmount?": money,
});
type Transaction = typeof ebayStatementTransaction.infer;
const page = type({
	"transactions?": ebayStatementTransaction.array(),
	"total?": "number",
});

// The statement's own names, in its order. Anything else eBay posts is
// listed by its type after these, never dropped.
const ACTIVITY: [string, string][] = [
	["CREDIT", "Claims"],
	["REFUND", "Refunds (net of fees and credits)"],
	["DISPUTE", "Payment disputes"],
	["SHIPPING_LABEL", "Shipping labels"],
	["NON_SALE_CHARGE", "Other fees"],
	["ADJUSTMENT", "Adjustment"],
	["PURCHASE", "Purchases"],
	["TRANSFER", "Charges"],
];
const PAYOUTS = new Set(["PAYOUT", "WITHDRAWAL"]);

const signed = (t: Transaction, n: number) =>
	t.bookingEntry === "CREDIT" ? n : -n;

export function ebayStatement(
	month: MonthWindow,
	transactions: Transaction[],
): Statement {
	const byType = new Map<string, number>();
	let gross = 0;
	let fees = 0;
	let refundedGross = 0;
	let tax = 0;
	for (const t of transactions) {
		const amount = signed(t, t.amount.value);
		const fee = t.totalFeeAmount?.value ?? 0;
		const collected = t.ebayCollectedTaxAmount?.value ?? 0;
		if (t.transactionType === "SALE") {
			// The sale's amount is what it paid us, its fees already off.
			gross += amount + fee;
			fees -= fee;
			tax += collected;
			continue;
		}
		if (t.transactionType === "REFUND") {
			refundedGross += -amount + fee;
			tax -= collected;
		}
		byType.set(
			t.transactionType,
			(byType.get(t.transactionType) ?? 0) + amount,
		);
	}
	const take = (type: string) => {
		const amount = byType.get(type) ?? 0;
		byType.delete(type);
		return amount;
	};
	const payouts = [...PAYOUTS].reduce((s, type) => s + take(type), 0);
	const activity: StatementLine[] = ACTIVITY.map(([type, label]) => ({
		label,
		amount: cents(take(type)),
	}));
	for (const [type, amount] of byType)
		activity.push({ label: words(type), amount: cents(amount) });

	const orders = [
		{ label: "Gross sales", amount: cents(gross) },
		{ label: "Selling fees", amount: cents(fees) },
	];
	return {
		channel: "ebay",
		window: month.json,
		netSales: cents(gross - refundedGross),
		marketplaceTax: cents(tax),
		sections: [
			{
				title: null,
				lines: orders,
				total: sectionTotal(orders, "Orders (total minus fees)"),
			},
			{
				title: null,
				lines: activity,
				total: sectionTotal([...orders, ...activity], "Activity for the month"),
			},
			// The month's payouts are listed with every marketplace's deposits;
			// shown here only when eBay files one among the transactions.
			...(payouts === 0
				? []
				: [
						{
							title: null,
							lines: [{ label: "Payouts", amount: cents(payouts) }],
							total: null,
						},
					]),
		],
	};
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, ".000Z");

async function ask(month: MonthWindow) {
	const found: Transaction[] = [];
	const last = new Date(month.end.getTime() - 1);
	for (let offset = 0; ; offset += PAGE) {
		const url = new URL(FINANCES);
		url.search = new URLSearchParams({
			filter: `transactionDate:[${iso(month.start)}..${last.toISOString()}]`,
			limit: String(PAGE),
			offset: String(offset),
		}).toString();
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${await accessToken()}` },
		});
		if (!response.ok)
			throw new Error(
				`eBay Finances answered ${response.status}: ${await response.text()}`,
			);
		const transactions = page.assert(await response.json()).transactions ?? [];
		found.push(...transactions);
		if (transactions.length < PAGE) return found;
	}
}

export async function fetchEbayStatement(month: MonthWindow) {
	const all = new Map<string, Transaction>();
	for (let i = 0; i < ASKS; i++)
		for (const t of await ask(month))
			all.set(`${t.transactionType}:${t.transactionId}`, t);
	return ebayStatement(month, [...all.values()]);
}
