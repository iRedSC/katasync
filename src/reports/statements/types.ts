import { type } from "arktype";

// A marketplace's own figures for one month, as its statement or sales report
// shows them, read from the marketplace rather than added up from katasync's
// orders. The marketplace decides what falls in the month (Amazon counts a
// sale when it ships, Shopify books an order edit on the day of the edit), so
// these match what the seller sees there, line for line.

const line = type({ label: "string", amount: "number" });
export type StatementLine = typeof line.infer;

const section = type({
	title: "string | null",
	lines: line.array(),
	total: line.or("null"),
});
export type StatementSection = typeof section.infer;

const window = type({ start: "string", end: "string", timeZone: "string" });

// One row of Shopify's sales report, by the channel the order came in on.
// Shopify includes every order it holds: TikTok's, the Shop app's, the
// counter's.
const shopifyRow = type({
	salesChannel: "string",
	orders: "number",
	grossSales: "number",
	discounts: "number",
	returns: "number",
	netSales: "number",
	shipping: "number",
	duties: "number",
	additionalFees: "number",
	taxes: "number",
	totalSales: "number",
});
export type ShopifySalesRow = typeof shopifyRow.infer;

export const statement = type({
	channel: "'shopify'",
	window,
	rows: shopifyRow.array(),
})
	.or({
		channel: "'amazon'",
		window,
		sections: section.array(),
		// Items sold less promotions and item refunds, before shipping and tax.
		netSales: "number",
		// Sales tax Amazon collected less what it refunded; Amazon pays it.
		marketplaceTax: "number",
	})
	.or({
		channel: "'ebay'",
		window,
		sections: section.array(),
		// What buyers paid before tax, less refunds. eBay doesn't split shipping
		// out of a sale.
		netSales: "number",
		marketplaceTax: "number",
	})
	.or({
		// TikTok's statements settle orders a week or more after delivery, so
		// they're money settled this month, not sales: TikTok's sales are in
		// Shopify's report, which TikTok relays every order to.
		channel: "'tiktok'",
		window,
		statements: "number",
		sections: section.array(),
	});
export type Statement = typeof statement.infer;
export type StatementChannel = Statement["channel"];

export const STATEMENT_CHANNELS = [
	"shopify",
	"amazon",
	"ebay",
	"tiktok",
] as const satisfies readonly StatementChannel[];

// What a report shows for a marketplace: its figures, or why there are none.
export const statementResult = type({
	channel: "'shopify' | 'amazon' | 'ebay' | 'tiktok'",
	state: "'read'",
	statement,
	// Read after the month ended. Until then the figures are the month so far.
	complete: "boolean",
	// The last try to read it again failed, so these are older figures.
	lastError: "string | null",
}).or({
	channel: "'shopify' | 'amazon' | 'ebay' | 'tiktok'",
	state: "'missing'",
	// Null when it was never asked yet.
	error: "string | null",
});
export type StatementResult = typeof statementResult.infer;

// Shopify channels whose tax the marketplace collects and pays: the Shop app
// and TikTok (src/channels/shopify/channel-order.ts).
const MARKETPLACE_TAXED = new Set(["Shop", "TikTok"]);
export const marketplaceTaxed = (r: ShopifySalesRow) =>
	MARKETPLACE_TAXED.has(r.salesChannel);

// Net sales as each marketplace counts them (before shipping and tax). Null
// for TikTok, whose sales Shopify's report already has.
export function netSalesOf(s: Statement): number | null {
	switch (s.channel) {
		case "shopify":
			return s.rows.reduce((sum, r) => sum + r.netSales, 0);
		case "amazon":
		case "ebay":
			return s.netSales;
		case "tiktok":
			return null;
	}
}

// Sales tax the marketplace collected and pays itself.
export function marketplaceTaxOf(s: Statement): number {
	switch (s.channel) {
		case "shopify":
			return s.rows
				.filter(marketplaceTaxed)
				.reduce((sum, r) => sum + r.taxes, 0);
		case "amazon":
		case "ebay":
			return s.marketplaceTax;
		case "tiktok":
			return 0;
	}
}

// Rounds to cents, so sums of many small floats print as the statement does.
export const cents = (n: number) => Math.round(n * 100) / 100;

export function sectionTotal(lines: StatementLine[], label: string) {
	return { label, amount: cents(lines.reduce((s, l) => s + l.amount, 0)) };
}

// Figures that can't stand as the month's: read before it ended, or a newer
// read failed since.
export const provisional = (r: StatementResult) =>
	r.state === "read" && (!r.complete || r.lastError !== null);
