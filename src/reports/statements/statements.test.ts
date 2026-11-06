import { describe, expect, it } from "vitest";
import { amazonStatement } from "./amazon";
import { ebayStatement } from "./ebay";
import { salesQuery, shopifyRows } from "./shopify";
import { tiktokStatement } from "./tiktok";
import type { Statement, StatementResult } from "./types";
import { statementFigures, statementSummary, statementView } from "./view";
import { monthWindow, PACIFIC } from "./window";

const october = monthWindow({ year: 2026, month: 10 }, PACIFIC);
const figure = (s: Statement, label: string) =>
	statementFigures(s).find((l) => l.label === label)?.amount;

describe("monthWindow", () => {
	it("starts and ends at midnight on the marketplace's clock, across a clock change", () => {
		expect(october.json).toEqual({
			start: "2026-10-01T07:00:00.000Z",
			end: "2026-11-01T07:00:00.000Z",
			timeZone: PACIFIC,
		});
		const nov = monthWindow({ year: 2026, month: 11 }, "America/New_York");
		expect(nov.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
		expect(nov.end.toISOString()).toBe("2026-12-01T05:00:00.000Z");
		expect(nov.lastDay).toBe("2026-11-30");
	});
});

describe("Shopify", () => {
	it("asks for the month's sales by channel, in the shop's days", () => {
		const q = salesQuery(
			monthWindow({ year: 2026, month: 2 }, "America/New_York"),
		);
		expect(q).toContain("GROUP BY sales_channel");
		expect(q).toContain("SINCE 2026-02-01 UNTIL 2026-02-28");
	});

	it("shows TikTok's discounts on a line of their own", () => {
		const rows = shopifyRows([
			{
				sales_channel: "TikTok",
				orders: 271,
				gross_sales: 26331.98,
				discounts: -1953.33,
				returns: -710.93,
				net_sales: 23667.72,
				shipping_charges: 1335.87,
				duties: 0,
				additional_fees: 0,
				taxes: 1821.29,
				total_sales: 26824.88,
			},
		]);
		const view = statementView({
			channel: "shopify",
			window: october.json,
			rows,
		});
		expect(view.kind === "table" && view.callouts).toEqual([
			{ label: "Discounts on TikTok orders", amount: -1953.33 },
		]);
		// Duties and fees nobody paid aren't columns.
		expect(
			view.kind === "table" && view.columns.map((c) => c.label),
		).not.toContain("Duties");
	});
});

describe("eBay", () => {
	const t = (
		transactionType: string,
		bookingEntry: "CREDIT" | "DEBIT",
		amount: number,
		fee = 0,
		tax = 0,
	) => ({
		transactionId: `${transactionType}-${amount}`,
		transactionType,
		bookingEntry,
		amount: { value: amount },
		totalFeeAmount: { value: fee },
		ebayCollectedTaxAmount: { value: tax },
	});

	it("nets fees out of orders and refunds as the statement does", () => {
		const s = ebayStatement(october, [
			t("SALE", "CREDIT", 77.14, 12.86, 8.1),
			t("SALE", "CREDIT", 100, 10, 0),
			t("REFUND", "DEBIT", 30, 5, 2),
			t("SHIPPING_LABEL", "DEBIT", 8.05),
			t("NON_SALE_CHARGE", "DEBIT", 59.95),
			t("LOAN_REPAYMENT", "DEBIT", 1),
		]);
		expect(figure(s, "Gross sales")).toBe(200);
		expect(figure(s, "Orders (total minus fees)")).toBe(177.14);
		expect(figure(s, "Refunds (net of fees and credits)")).toBe(-30);
		expect(figure(s, "Shipping labels")).toBe(-8.05);
		expect(figure(s, "Other fees")).toBe(-59.95);
		// A kind the statement doesn't name is listed, not dropped.
		expect(figure(s, "Loan repayment")).toBe(-1);
		expect(s.channel === "ebay" && s.netSales).toBe(165);
		expect(s.channel === "ebay" && s.marketplaceTax).toBe(6.1);
	});
});

describe("TikTok", () => {
	it("adds up its statements, and names what its parts don't cover", () => {
		const s = tiktokStatement(october, [
			{
				id: "1",
				statement_time: 1,
				revenue_amount: 100,
				fee_amount: -10,
				shipping_cost_amount: -5,
				adjustment_amount: 0,
				settlement_amount: 84,
			},
		]);
		expect(figure(s, "Other")).toBe(-1);
		expect(figure(s, "Total settlement")).toBe(84);
	});
});

describe("Amazon", () => {
	type Node = {
		breakdownType: string;
		breakdownAmount: { currencyAmount: number };
		breakdowns: Node[];
	};
	const b = (
		breakdownType: string,
		amount: number,
		breakdowns: Node[] = [],
	): Node => ({
		breakdownType,
		breakdownAmount: { currencyAmount: amount },
		breakdowns,
	});
	const shipment = {
		transactionType: "Shipment",
		totalAmount: { currencyAmount: 85 },
		breakdowns: [
			b("Sales", 106, [b("ProductCharges", 100), b("ProductTax", 6)]),
			b("Expenses", -15, [b("AmazonFees", -15, [b("Commission", -15)])]),
			b("Tax", -6, [b("MarketplaceFacilitatorTax-Principal", -6)]),
		],
	};
	const refund = {
		transactionType: "Refund",
		totalAmount: { currencyAmount: -50 },
		breakdowns: [
			b("Refunded Sales", -53, [b("ProductCharges", -50), b("ProductTax", -3)]),
			b("Tax", 3, [b("MarketplaceFacilitatorTax-Principal", 3)]),
		],
	};

	it("files each amount under the summary's lines, and adds up to Amazon's totals", () => {
		const s = amazonStatement(october, [
			shipment as never,
			refund as never,
			// Something it doesn't know, with an amount its parts don't explain.
			{
				transactionType: "Retrocharge",
				totalAmount: { currencyAmount: -2 },
			} as never,
		]);
		expect(figure(s, "Income: Product sales")).toBe(100);
		expect(figure(s, "Income: Product sale refunds")).toBe(-50);
		expect(figure(s, "Expenses: Seller fulfilled selling fees")).toBe(-15);
		expect(
			figure(
				s,
				"Tax: Product, shipping, gift wrap taxes and regulatory fee collected",
			),
		).toBe(6);
		expect(figure(s, "Tax: Net taxes collected")).toBe(0);
		expect(figure(s, "Not yet sorted: Retrocharge: Not itemized")).toBe(-2);
		expect(s.channel === "amazon" && s.netSales).toBe(50);
		expect(s.channel === "amazon" && s.marketplaceTax).toBe(3);
		const total = statementFigures(s)
			.filter((l) =>
				/ (sales, credits, and refunds|fees, shipping labels, and other charges|taxes collected)$|^Not yet sorted: Other activity$/.test(
					l.label,
				),
			)
			.reduce((sum, l) => sum + l.amount, 0);
		expect(total).toBeCloseTo(85 - 50 - 2);
	});

	it("counts a held-back shipment once, when it first posted", () => {
		const copy = {
			...shipment,
			relatedIdentifiers: [
				{
					relatedIdentifierName: "DEFERRED_TRANSACTION_ID",
					relatedIdentifierValue: "x",
				},
			],
		};
		const s = amazonStatement(october, [shipment as never, copy as never]);
		expect(figure(s, "Income: Product sales")).toBe(100);
	});
});

describe("statementSummary", () => {
	const read = (s: Statement): StatementResult => ({
		channel: s.channel,
		state: "read",
		statement: s,
		complete: true,
		lastError: null,
	});
	const ebay = ebayStatement(october, []);

	it("won't sum net sales while a marketplace it needs isn't read", () => {
		const summary = statementSummary(
			[read(ebay), { channel: "amazon", state: "missing", error: null }],
			0,
		);
		expect(summary.netSales).toBeNull();
		expect(summary.netSalesMissing).toEqual(["shopify", "amazon"]);
		expect(summary.marketplaceTax).toBeNull();
	});
});
