import { channelName } from "#/lib/format";
import { placeName, taxName } from "#/lib/places";
import {
	parsePeriod,
	payoutTotals,
	periodDays,
	shopDay,
} from "#/orders/sales-report";
import { type Cell, csvText, decimal } from "./csv";
import { FEE_EVIDENCE, type FeeEvidence } from "./evidence";
import {
	type ChannelLine,
	contributionFigure,
	RENDERER_VERSION,
	type ReportData,
} from "./snapshot";

export const CSV_FILES = [
	"sales",
	"sales-tax",
	"sales-by-state",
	"deposits",
	"contribution",
	"evidence",
] as const;
export type CsvFile = (typeof CSV_FILES)[number];

export type RevisionMeta = {
	revision: number;
	asOf: string;
	dataDigest: string;
};

export const sourceName = (s: ChannelLine["source"]) =>
	s === "retail"
		? "Point of Sale"
		: s === "shop"
			? "Shop app"
			: s === "shopify"
				? "Online Store"
				: channelName(s);

const soldOn = (s: ChannelLine["source"]) =>
	s === "retail" || s === "shop" ? "shopify" : s;

export const HOW_SUFFIX: Record<ReportData["states"][number]["how"], string> = {
	shipped: "",
	in_store: " (retail)",
	no_address: " (pickup)",
};

export const FEE_EVIDENCE_NAME: Record<FeeEvidence, string> = {
	settled: "Fees settled by marketplace",
	reported: "Fees reported, may still change",
	aged_out: "Fees over 60 days old, never settled",
	estimated: "Fees estimated, not reported",
};

const money = (n: number) => decimal(n);

type Numbers = Omit<ChannelLine, "source">;
const NUMBERS = [
	"orders",
	"itemSales",
	"shipping",
	"grossSales",
	"marketplaceTax",
	"ourTax",
	"refunds",
	"fees",
	"labels",
	"postageAdjustments",
	"adjustments",
	"proceedsBeforeCost",
	"feesEstimated",
	"taxUnknown",
] as const satisfies readonly (keyof Numbers)[];

export function channelTotal(rows: ChannelLine[]): Numbers {
	return Object.fromEntries(
		NUMBERS.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)]),
	) as Numbers;
}

function sales(d: ReportData): Cell[][] {
	const line = (name: string, r: Numbers, firstOrder: Cell): Cell[] => [
		name,
		r.orders,
		money(r.itemSales),
		money(r.shipping),
		money(r.grossSales),
		money(r.marketplaceTax),
		money(r.ourTax),
		money(r.refunds),
		money(r.fees),
		money(r.labels),
		money(r.postageAdjustments),
		money(r.adjustments),
		money(r.proceedsBeforeCost),
		r.taxUnknown,
		r.feesEstimated,
		firstOrder,
	];
	const firstOrder = (s: ChannelLine["source"]) => {
		const p = d.partial.find((x) => x.channel === soldOn(s));
		return p ? shopDay(new Date(p.firstOrder)) : null;
	};
	return [
		[
			"Sold on",
			"Orders",
			"Item sales",
			"Shipping",
			"Gross sales",
			"Tax paid by marketplace",
			"Tax you collected",
			"Refunds",
			"Fees",
			"Labels",
			"Postage adjustments",
			"Adjustments",
			"Proceeds before product cost",
			"Tax not read (orders)",
			"Fees estimated (orders)",
			"No orders before",
		],
		...d.channels.map((r) =>
			line(sourceName(r.source), r, firstOrder(r.source)),
		),
		...(d.channels.length > 1
			? [line("Total", channelTotal(d.channels), null)]
			: []),
	];
}

function salesTax(d: ReportData): Cell[][] {
	return [
		["Jurisdiction", "Rate", "Orders", "Sales on taxed orders", "Tax"],
		...d.jurisdictions.map((r) => [
			taxName(r),
			r.rate,
			r.orders,
			money(r.taxedSales),
			money(r.tax),
		]),
	];
}

function salesByState(d: ReportData): Cell[][] {
	return [
		["State", "Orders", "Sales", "Tax charged"],
		...d.states.map((r) => [
			`${placeName(r)}${HOW_SUFFIX[r.how]}`,
			r.orders,
			money(r.sales),
			money(r.tax),
		]),
	];
}

const STATUS = { sent: "Sent", pending: "On its way", failed: "Failed" };

function deposits(d: ReportData): Cell[][] {
	const currencies = [...new Set(d.deposits.map((r) => r.currency))];
	return [
		[
			"Date",
			"Time",
			"From",
			"Status",
			"Account",
			"Reference",
			"Amount",
			"Currency",
		],
		...d.deposits.map((r) => [
			shopDay(new Date(r.depositedAt)),
			r.depositedAt,
			channelName(r.channel),
			STATUS[r.status],
			r.bankTail,
			r.reference,
			money(r.amount),
			r.currency,
		]),
		...currencies.flatMap((currency) => {
			const mine = d.deposits.filter((r) => r.currency === currency);
			const t = payoutTotals(mine);
			const blank = [null, null, null, null, null];
			return [
				["Sent", ...blank, money(t.sent), currency],
				...(mine.some((r) => r.status === "pending")
					? [["On its way", ...blank, money(t.pending), currency]]
					: []),
			];
		}),
	];
}

export function contributionStatus(d: ReportData): string {
	const f = contributionFigure(d.contribution);
	switch (f.kind) {
		case "complete":
			return "All costs in";
		case "estimated":
			return `Rests on ${f.estimatedOrders} orders not final`;
		case "unknown":
			return `Unknown: ${f.costUnknown} orders missing product cost, ${f.labelsMissing} missing label cost`;
	}
}

function contribution(d: ReportData): Cell[][] {
	const c = d.contribution;
	const f = contributionFigure(c);
	return [
		["Shipped orders", "Amount", "Orders", "Status"],
		["Orders", null, c.orders, null],
		["Item sales", money(c.revenue), null, null],
		["Shipping charged", money(c.shippingCharged), null, null],
		[
			"Product cost",
			money(-c.cost),
			c.costUnknown,
			c.costUnknown > 0 ? "Orders missing cost" : null,
		],
		[
			"Cost corrections on goods already sold",
			money(-c.costCorrections),
			null,
			null,
		],
		[
			"Fees",
			money(-c.fees),
			c.feesEstimated,
			c.feesEstimated > 0 ? "Orders with estimated fees" : null,
		],
		[
			"Labels",
			money(-c.labels),
			c.labelsMissing,
			c.labelsMissing > 0 ? "Orders missing label cost" : null,
		],
		["Postage adjustments", money(-c.postageAdjustments), null, null],
		["Refunds", money(-c.refunds), null, null],
		["Adjustments", money(-c.adjustments), null, null],
		[
			"Contribution before overhead",
			f.kind === "unknown" ? null : money(f.value),
			null,
			contributionStatus(d),
		],
	];
}

function evidence(d: ReportData): Cell[][] {
	return [
		["Marketplace", "Evidence", "Orders", "Fees"],
		...d.evidence.flatMap((r) => {
			const name = channelName(r.soldOn);
			const gaps: [string, number][] = [
				["Labels missing", r.labelsMissing],
				["Labels estimated", r.labelsStandIn],
				["Labels awaited", r.labelsAwaiting],
				["Product cost missing", r.costUnknown],
				["Tax not read", r.taxUnknown],
			];
			return [
				...FEE_EVIDENCE.map((e): Cell[] => [
					name,
					FEE_EVIDENCE_NAME[e],
					r.fees[e].orders,
					money(r.fees[e].amount),
				]),
				...gaps
					.filter(([, n]) => n > 0)
					.map(([label, n]): Cell[] => [name, label, n, null]),
			];
		}),
	];
}

export function csvFile(d: ReportData, file: CsvFile): string {
	switch (file) {
		case "sales":
			return csvText(sales(d));
		case "sales-tax":
			return csvText(salesTax(d));
		case "sales-by-state":
			return csvText(salesByState(d));
		case "deposits":
			return csvText(deposits(d));
		case "contribution":
			return csvText(contribution(d));
		case "evidence":
			return csvText(evidence(d));
	}
}

export function aboutFile(d: ReportData, meta: RevisionMeta): string {
	const period = parsePeriod(d.period);
	return csvText([
		["Field", "Value"],
		["Business", d.business.name],
		["Report", "Sales and sales tax"],
		["Period", d.period],
		["Days", period ? periodDays(period) : null],
		["Basis", "Order date, orders not cancelled, as known at As of"],
		["Window start", d.window.start],
		["Window end", d.window.end],
		["Revision", meta.revision],
		["As of", meta.asOf],
		["Time zone", d.timeZone],
		["Currency", d.currency],
		["Schema version", d.schemaVersion],
		["Renderer version", RENDERER_VERSION],
		["Source", d.source],
		["Tax source", "Tax lines as each marketplace reported them; not a filing"],
		["Contribution", "Shipped orders only, before overhead"],
		["Data digest", meta.dataDigest],
	]);
}
