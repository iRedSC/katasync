import {
	cents,
	type KatasyncTax,
	marketplaceTaxed,
	marketplaceTaxOf,
	netSalesOf,
	provisional,
	type ShopifySalesRow,
	STATEMENT_CHANNELS,
	type Statement,
	type StatementChannel,
	type StatementLine,
	type StatementResult,
	type StatementSection,
} from "./types";

// How every surface (the printed report, the Reports tab, the saved HTML and
// CSVs) shows a marketplace's figures, so they all read the same lines.

export const STATEMENT_NAME: Record<StatementChannel, string> = {
	shopify: "Shopify",
	amazon: "Amazon",
	ebay: "eBay",
	tiktok: "TikTok",
};

// What each block is, in the marketplace's own words, and what decides the
// month: the line a reader checks it against.
export const STATEMENT_TITLE: Record<StatementChannel, string> = {
	shopify: "Total sales by sales channel, as Analytics shows it",
	amazon: "Account activity, as the Date Range Reports summary shows it",
	ebay: "Financial statement",
	tiktok: "Statements settled this month",
};

export const STATEMENT_BASIS: Record<StatementChannel, string> = {
	shopify:
		"Eastern time. Includes TikTok, POS and Shop app orders. Edits and refunds count on the day they happen.",
	amazon:
		"Pacific time. A sale counts when Amazon posts the shipment; a refund when it's issued.",
	ebay: "Pacific time. A refund counts when it's issued.",
	tiktok:
		"Pacific time. Money settled for orders delivered earlier, not this month's sales, which are in Shopify's report.",
};

export type Column = { label: string; count?: boolean };

export type StatementView =
	| {
			kind: "table";
			columns: Column[];
			rows: { label: string; cells: number[] }[];
			total: number[];
			// Lines worth reading on their own: TikTok's discounts.
			callouts: StatementLine[];
	  }
	| { kind: "lines"; sections: StatementSection[] };

const SHOPIFY_COLUMNS: [Column, (r: ShopifySalesRow) => number][] = [
	[{ label: "Orders", count: true }, (r) => r.orders],
	[{ label: "Gross sales" }, (r) => r.grossSales],
	[{ label: "Discounts" }, (r) => r.discounts],
	[{ label: "Returns" }, (r) => r.returns],
	[{ label: "Net sales" }, (r) => r.netSales],
	[{ label: "Shipping" }, (r) => r.shipping],
	[{ label: "Duties" }, (r) => r.duties],
	[{ label: "Additional fees" }, (r) => r.additionalFees],
	[{ label: "Taxes" }, (r) => r.taxes],
	[{ label: "Total sales" }, (r) => r.totalSales],
];

export function statementView(s: Statement): StatementView {
	// A $0 line says nothing, so it's left out; totals always show.
	if (s.channel !== "shopify")
		return {
			kind: "lines",
			sections: s.sections.map((sec) => ({
				...sec,
				lines: sec.lines.filter((l) => l.amount !== 0),
			})),
		};
	// Duties and additional fees only when the month has any.
	const shown = SHOPIFY_COLUMNS.filter(
		([c, get]) =>
			(c.label !== "Duties" && c.label !== "Additional fees") ||
			s.rows.some((r) => get(r) !== 0),
	);
	const tiktok = s.rows.find((r) => r.salesChannel === "TikTok");
	return {
		kind: "table",
		columns: shown.map(([c]) => c),
		rows: s.rows.map((r) => ({
			label: r.salesChannel,
			cells: shown.map(([, get]) => get(r)),
		})),
		total: shown.map(([, get]) =>
			cents(s.rows.reduce((sum, r) => sum + get(r), 0)),
		),
		callouts:
			tiktok && tiktok.discounts !== 0
				? [{ label: "Discounts on TikTok orders", amount: tiktok.discounts }]
				: [],
	};
}

// Every figure a statement has, as "where: amount", for comparing revisions
// and for the CSV. Names stay stable from one read to the next.
export function statementFigures(s: Statement): StatementLine[] {
	const view = statementView(s);
	if (view.kind === "table")
		return [
			...view.rows.flatMap((r) =>
				view.columns.map((c, i) => ({
					label: `${r.label}: ${c.label}`,
					amount: r.cells[i],
				})),
			),
			...view.columns.map((c, i) => ({
				label: `Total: ${c.label}`,
				amount: view.total[i],
			})),
		];
	return view.sections.flatMap((sec) => {
		const where = sec.title ? `${sec.title}: ` : "";
		return [
			...sec.lines.map((l) => ({ ...l, label: `${where}${l.label}` })),
			...(sec.total
				? [{ ...sec.total, label: `${where}${sec.total.label}` }]
				: []),
		];
	});
}

export type MarketplaceTaxRow = { label: string; amount: number };

// The month's headline from the marketplaces' own figures. A figure that
// needs a marketplace not read yet is null, with the missing ones named, so
// a partial sum can't pass for the whole.
export function statementSummary(
	results: StatementResult[],
	katasync: KatasyncTax,
) {
	const read = new Map<StatementChannel, Statement>();
	for (const r of results)
		if (r.state === "read") read.set(r.channel, r.statement);
	const missing = STATEMENT_CHANNELS.filter((c) => !read.has(c));

	const salesFrom: StatementChannel[] = ["shopify", "amazon", "ebay"];
	const netSales = salesFrom.every((c) => read.has(c))
		? cents(
				salesFrom.reduce(
					(sum, c) => sum + (netSalesOf(read.get(c) as Statement) ?? 0),
					0,
				),
			)
		: null;

	const taxRows: MarketplaceTaxRow[] = [];
	const shopify = read.get("shopify");
	if (shopify?.channel === "shopify")
		for (const r of shopify.rows.filter(marketplaceTaxed))
			taxRows.push({
				label: r.salesChannel === "Shop" ? "Shop app" : r.salesChannel,
				amount: r.taxes,
			});
	for (const c of ["amazon", "ebay"] as const) {
		const s = read.get(c);
		if (s)
			taxRows.push({
				label: STATEMENT_NAME[c],
				amount: marketplaceTaxOf(s, katasync),
			});
	}
	if (katasync.international !== 0)
		taxRows.push({ label: "International", amount: katasync.international });
	const taxMissing = (["shopify", "amazon", "ebay"] as const).filter(
		(c) => !read.has(c),
	);
	return {
		missing,
		// Marketplaces whose figures are the month so far, or older than the
		// last try to read them: a sum with them isn't final.
		provisional: results.filter(provisional).map((r) => r.channel),
		netSales,
		netSalesMissing: salesFrom.filter((c) => !read.has(c)),
		taxRows,
		marketplaceTax:
			taxMissing.length === 0
				? cents(taxRows.reduce((s, r) => s + r.amount, 0))
				: null,
		taxMissing,
	};
}

// Why a read marketplace's figures aren't yet the month's, in a line, or null
// when they are.
export function statementCaveat(r: StatementResult): string | null {
	if (r.state !== "read") return null;
	if (r.lastError !== null) return "Older figures: reading again failed";
	if (!r.complete) return "Month so far";
	return null;
}

// One row per channel for the overview: each marketplace's own figures in
// the same columns. A figure the marketplace doesn't report is null (Amazon
// and eBay don't count orders here; eBay doesn't split shipping out of a
// sale), so it prints as a dash rather than as a zero.
export type ChannelSummaryRow = {
	channel: StatementChannel;
	// The Shopify channel, or the marketplace's name.
	label: string;
	state: "read" | "missing";
	orders: number | null;
	grossSales: number | null;
	discounts: number | null;
	refunds: number | null;
	netSales: number | null;
	shipping: number | null;
	tax: number | null;
};

const blank = {
	orders: null,
	grossSales: null,
	discounts: null,
	refunds: null,
	netSales: null,
	shipping: null,
	tax: null,
};

const sumLines = (s: Statement, match: RegExp) =>
	"sections" in s
		? cents(
				s.sections
					.flatMap((sec) => sec.lines)
					.filter((l) => match.test(l.label))
					.reduce((sum, l) => sum + l.amount, 0),
			)
		: 0;

export function channelSummary(
	results: StatementResult[],
	katasync: KatasyncTax,
): ChannelSummaryRow[] {
	return results.flatMap((r): ChannelSummaryRow[] => {
		// TikTok's sales are Shopify's TikTok row; its statements are money
		// settled, on page 2.
		if (r.channel === "tiktok") return [];
		const name = STATEMENT_NAME[r.channel];
		if (r.state === "missing")
			return [{ channel: r.channel, label: name, state: "missing", ...blank }];
		const s = r.statement;
		switch (s.channel) {
			case "shopify":
				return s.rows.map((row) => ({
					channel: "shopify",
					label: row.salesChannel === "Shop" ? "Shop app" : row.salesChannel,
					state: "read",
					orders: row.orders,
					grossSales: row.grossSales,
					discounts: row.discounts,
					refunds: row.returns,
					netSales: row.netSales,
					shipping: row.shipping,
					tax: row.taxes,
				}));
			case "amazon":
				return [
					{
						channel: "amazon",
						label: name,
						state: "read",
						orders: null,
						grossSales: sumLines(s, /^(FBA )?product sales/i),
						discounts: sumLines(s, /^promotional rebates$/i),
						refunds: sumLines(
							s,
							/product sale refunds|promotional rebate refunds/i,
						),
						netSales: s.netSales,
						shipping: sumLines(s, /^shipping credit/i),
						tax: katasync.amazon,
					},
				];
			case "ebay": {
				const gross = sumLines(s, /^gross sales$/i);
				return [
					{
						channel: "ebay",
						label: name,
						state: "read",
						orders: null,
						grossSales: gross,
						discounts: null,
						refunds: cents(s.netSales - gross),
						netSales: s.netSales,
						shipping: null,
						tax: s.marketplaceTax,
					},
				];
			}
			case "tiktok":
				return [];
		}
	});
}
