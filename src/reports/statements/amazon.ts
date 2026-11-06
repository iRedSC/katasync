import { type } from "arktype";
import { MARKETPLACE_US, spApi } from "#/channels/amazon-api";
import {
	cents,
	type Statement,
	type StatementLine,
	type StatementSection,
} from "./types";
import type { MonthWindow } from "./window";

// Amazon's account activity for the month (Pacific time), as Seller Central's
// Date Range Reports summary groups it: income, expenses, tax and transfers,
// from every Finances transaction posted in the month. Amazon counts a sale
// when it posts the shipment, not when it was ordered.
//
// Each amount is filed under a line by Amazon's own breakdown names. One this
// doesn't recognize is listed under Other with Amazon's name, never dropped,
// and whatever a transaction's breakdowns don't itemize is listed too, so the
// month always adds up to Amazon's own transaction totals.

// Amazon sends a field it has no value for as null as often as it leaves it
// out, so every optional field takes either.
const money = type({
	currencyAmount: "number",
	"currencyCode?": "string | null",
});
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
const context = type({
	"contextType?": "string | null",
	"fulfillmentNetwork?": "string | null",
});
export const amazonStatementTransaction = type({
	transactionType: "string",
	"postedDate?": "string | null",
	"totalAmount?": money,
	"marketplaceDetails?": type({ "marketplaceId?": "string | null" }).or("null"),
	"relatedIdentifiers?": type({
		relatedIdentifierName: "string",
		relatedIdentifierValue: "string",
	})
		.array()
		.or("null"),
	"contexts?": context.array().or("null"),
	"items?": type({ "contexts?": context.array().or("null") })
		.array()
		.or("null"),
	"breakdowns?": breakdown.array().or("null"),
});
type Transaction = typeof amazonStatementTransaction.infer;
const response = type({
	payload: {
		"transactions?": amazonStatementTransaction.array(),
		"nextToken?": "string | null",
	},
});

type Group = "income" | "expenses" | "tax" | "transfers" | "other";
type Filed = { group: Group; label: string };

// "FBAPerUnitFulfillmentFee" → "FBA per unit fulfillment fee".
function words(name: string) {
	const text = name
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replaceAll("_", " ")
		.toLowerCase();
	return text.charAt(0).toUpperCase() + text.slice(1);
}

// FBA when Amazon says the item went out through its own network.
function network(t: Transaction): "fba" | "mfn" | null {
	const all = [
		...(t.contexts ?? []),
		...(t.items ?? []).flatMap((i) => i.contexts ?? []),
	];
	const named = all.map((c) => c.fulfillmentNetwork).filter(Boolean);
	if (named.length === 0) return null;
	return named.some((n) => /afn|amazon/i.test(n ?? "")) ? "fba" : "mfn";
}

const productLabel = (n: "fba" | "mfn" | null, refund: boolean) =>
	n === "fba"
		? refund
			? "FBA product sale refunds"
			: "FBA product sales"
		: n === "mfn"
			? refund
				? "Product sale refunds (non-FBA)"
				: "Product sales (non-FBA)"
			: refund
				? "Product sale refunds"
				: "Product sales";

export function fileAmount(
	t: Transaction,
	path: string[],
	fbaOrMfn: "fba" | "mfn" | null,
): Filed {
	const type = t.transactionType;
	const refund = /refund/i.test(type);
	const all = path.join("/");
	const leaf = path[path.length - 1] ?? type;
	if (/transfer|disburse/i.test(type))
		return { group: "transfers", label: "Transfers to bank account" };
	if (/tax/i.test(all)) {
		if (/withh|facilitator/i.test(all))
			return {
				group: "tax",
				label: "Amazon obligated tax and regulatory fee withheld",
			};
		return {
			group: "tax",
			label: refund
				? "Product, shipping, gift wrap taxes and regulatory fee refunded"
				: "Product, shipping, gift wrap taxes and regulatory fee collected",
		};
	}
	if (/postagebilling|shippingservice|shippinglabel/i.test(all)) {
		if (/adjust|chargeback/i.test(all))
			return { group: "expenses", label: "Carrier shipping label adjustments" };
		return {
			group: "expenses",
			label: refund ? "Shipping label refunds" : "Shipping label purchases",
		};
	}
	if (/promo/i.test(all))
		return {
			group: "income",
			label: refund ? "Promotional rebate refunds" : "Promotional rebates",
		};
	if (/giftwrap/i.test(all))
		return {
			group: "income",
			label: refund ? "Gift wrap credit refunds" : "Gift wrap credits",
		};
	if (/fee|commission/i.test(all)) {
		const fba = /fba|fulfil/i.test(all);
		if (/^ServiceFee$/i.test(type))
			return { group: "expenses", label: "Service fees" };
		return {
			group: "expenses",
			label: fba
				? refund
					? "FBA transaction fee refunds"
					: "FBA transaction fees"
				: refund
					? "Selling fee refunds"
					: fbaOrMfn === "fba"
						? "FBA selling fees"
						: "Seller fulfilled selling fees",
		};
	}
	if (/shipping/i.test(all))
		return {
			group: "income",
			label: refund ? "Shipping credit refunds" : "Shipping credits",
		};
	if (/sales|product|principal|price/i.test(all))
		return { group: "income", label: productLabel(fbaOrMfn, refund) };
	if (/advertis|productads/i.test(type))
		return { group: "expenses", label: "Cost of advertising" };
	return { group: "other", label: `${words(type)}: ${words(leaf)}` };
}

// Every itemized amount, by its path of breakdown names. A node whose parts
// don't add up to it keeps the difference as its own amount.
function leaves(b: Breakdown, path: string[]): [string[], number][] {
	const here = [...path, b.breakdownType];
	const parts = b.breakdowns ?? [];
	if (parts.length === 0) return [[here, b.breakdownAmount.currencyAmount]];
	const found = parts.flatMap((p) => leaves(p, here));
	const rest =
		b.breakdownAmount.currencyAmount - found.reduce((s, [, n]) => s + n, 0);
	return Math.abs(rest) >= 0.005 ? [...found, [here, rest]] : found;
}

// A shipment Amazon held back shows up twice once released: the original,
// and a copy pointing back at it. Only the original counts (as in
// src/channels/finance/amazon.ts).
const isReleaseCopy = (t: Transaction) =>
	t.relatedIdentifiers?.some(
		(r) => r.relatedIdentifierName === "DEFERRED_TRANSACTION_ID",
	) ?? false;

const GROUPS: [Group, string, string][] = [
	["income", "Income", "Net sales, credits, and refunds"],
	["expenses", "Expenses", "Net fees, shipping labels, and other charges"],
	["tax", "Tax", "Net taxes collected"],
	["other", "Not yet sorted", "Other activity"],
	["transfers", "Transfers", "Net deposits and withdrawals"],
];

export function amazonStatement(
	month: MonthWindow,
	transactions: Transaction[],
): Statement {
	const sums = new Map<string, { group: Group; amount: number }>();
	const add = (f: Filed, amount: number) => {
		const key = `${f.group}\u0000${f.label}`;
		const at = sums.get(key) ?? { group: f.group, amount: 0 };
		at.amount += amount;
		sums.set(key, at);
	};
	for (const t of transactions) {
		if (isReleaseCopy(t)) continue;
		// The account's other marketplaces (Canada, Mexico) are theirs. Asked
		// without a marketplace, since that filter also drops orders we ship
		// ourselves, so they're set aside here.
		const market = t.marketplaceDetails?.marketplaceId;
		if (market && market !== MARKETPLACE_US) continue;
		// Never added into dollars: the month fails instead, and says why.
		const currency = t.totalAmount?.currencyCode;
		if (currency && currency !== "USD")
			throw new Error(
				`Amazon posted a ${t.transactionType} in ${currency} for the US marketplace`,
			);
		const n = network(t);
		let itemized = 0;
		for (const top of t.breakdowns ?? [])
			for (const [path, amount] of leaves(top, [])) {
				add(fileAmount(t, path, n), amount);
				itemized += amount;
			}
		const rest = (t.totalAmount?.currencyAmount ?? itemized) - itemized;
		if (Math.abs(rest) >= 0.005) add(fileAmount(t, ["NotItemized"], n), rest);
	}

	const sections: StatementSection[] = [];
	for (const [group, title, totalLabel] of GROUPS) {
		const lines: StatementLine[] = [...sums.entries()]
			.filter(([, v]) => v.group === group)
			.map(([key, v]) => ({
				label: key.split("\u0000")[1],
				amount: cents(v.amount),
			}))
			.filter((l) => l.amount !== 0)
			.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
		if (lines.length === 0 && group === "other") continue;
		sections.push({
			title,
			lines,
			total: {
				label: totalLabel,
				amount: cents(lines.reduce((s, l) => s + l.amount, 0)),
			},
		});
	}

	const amountOf = (match: (label: string) => boolean) =>
		cents(
			[...sums.entries()]
				.filter(([key]) => match(key.split("\u0000")[1]))
				.reduce((s, [, v]) => s + v.amount, 0),
		);
	return {
		channel: "amazon",
		window: month.json,
		sections,
		netSales: amountOf((l) =>
			/^(FBA )?product sale|^promotional rebate/i.test(l),
		),
		marketplaceTax: amountOf((l) =>
			/taxes and regulatory fee (collected|refunded)/.test(l),
		),
	};
}

// Amazon refuses a postedBefore later than two minutes ago.
const SETTLE_MS = 3 * 60_000;

export async function fetchAmazonStatement(
	month: MonthWindow,
	now = new Date(),
) {
	const before = new Date(
		Math.min(month.end.getTime(), now.getTime() - SETTLE_MS),
	);
	const all: Transaction[] = [];
	let nextToken: string | null | undefined;
	do {
		const query = new URLSearchParams({
			postedAfter: month.start.toISOString(),
			postedBefore: before.toISOString(),
			...(nextToken ? { nextToken } : {}),
		});
		const { payload } = response.assert(
			await spApi(`/finances/2024-06-19/transactions?${query}`),
		);
		all.push(...(payload.transactions ?? []));
		nextToken = payload.nextToken;
	} while (nextToken);
	return amazonStatement(month, all);
}
