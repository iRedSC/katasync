import { type } from "arktype";
import { SHOP_TIME_ZONE } from "#/lib/format";
import type { ProfitTotals } from "#/orders/profit";
import {
	type Period,
	periodText,
	type SalesReport,
} from "#/orders/sales-report";
import type { EvidenceRow } from "./evidence";

export const SCHEMA_VERSION = 1;
export const RENDERER_VERSION = 1;
export const REPORT_CURRENCY = "USD";
export const REPORT_SOURCE =
	"katasync order_profit, order_taxes, order_cost_reports, cost_entries, payouts";

const marketplace = "'shopify' | 'amazon' | 'ebay' | 'tiktok'";
const bucket = type({ orders: "number", amount: "number" });

const channelRow = type({
	source: "'shopify' | 'retail' | 'shop' | 'amazon' | 'ebay' | 'tiktok'",
	orders: "number",
	itemSales: "number",
	shipping: "number",
	grossSales: "number",
	marketplaceTax: "number",
	ourTax: "number",
	refunds: "number",
	fees: "number",
	labels: "number",
	postageAdjustments: "number",
	adjustments: "number",
	proceedsBeforeCost: "number",
	feesEstimated: "number",
	taxUnknown: "number",
});

const jurisdictionRow = type({
	country: "string",
	jurisdiction: "string",
	rate: "number | null",
	orders: "number",
	taxedSales: "number",
	tax: "number",
});

const stateRow = type({
	country: "string",
	state: "string | null",
	how: "'in_store' | 'shipped' | 'no_address'",
	orders: "number",
	taxedOrders: "number",
	sales: "number",
	tax: "number",
});

const depositRow = type({
	externalId: "string",
	channel: marketplace,
	status: "'sent' | 'pending' | 'failed'",
	depositedAt: "string",
	amount: "number",
	currency: "string",
	bankTail: "string | null",
	reference: "string | null",
});

const contribution = type({
	orders: "number",
	revenue: "number",
	shippingCharged: "number",
	cost: "number",
	costUnknown: "number",
	costCorrections: "number",
	fees: "number",
	estimatedFees: "number",
	feesEstimated: "number",
	labels: "number",
	labelsMissing: "number",
	labelsStandIn: "number",
	labelsAwaiting: "number",
	postageAdjustments: "number",
	refunds: "number",
	adjustments: "number",
	awaitingReturn: "number",
	contribution: "number",
});

const evidenceRow = type({
	soldOn: marketplace,
	orders: "number",
	fees: {
		settled: bucket,
		reported: bucket,
		aged_out: bucket,
		estimated: bucket,
	},
	labelsMissing: "number",
	labelsStandIn: "number",
	labelsAwaiting: "number",
	costUnknown: "number",
	taxUnknown: "number",
});

export const reportData = type({
	schemaVersion: "1",
	kind: "'sales_tax_month'",
	period: "string",
	basis: "'order_date'",
	currency: "string",
	timeZone: "string",
	source: "string",
	window: { start: "string", end: "string" },
	business: { name: "string | null", homeState: "string | null" },
	channels: channelRow.array(),
	jurisdictions: jurisdictionRow.array(),
	states: stateRow.array(),
	deposits: depositRow.array(),
	payoutErrors: type({ channel: marketplace, error: "string" }).array(),
	partial: type({ channel: marketplace, firstOrder: "string" }).array(),
	contribution,
	evidence: evidenceRow.array(),
});

export type ReportData = typeof reportData.infer;
export type ChannelLine = ReportData["channels"][number];
export type Contribution = ReportData["contribution"];

export function parseReportData(value: unknown): ReportData {
	const parsed = reportData(value);
	if (parsed instanceof type.errors)
		throw new Error(`Saved report doesn't read: ${parsed.summary}`);
	return parsed;
}

export function toReportData(input: {
	period: Period;
	window: { start: Date; end: Date };
	sales: SalesReport;
	totals: ProfitTotals;
	evidence: EvidenceRow[];
}): ReportData {
	const { sales, totals: t } = input;
	return orderedReport({
		schemaVersion: SCHEMA_VERSION,
		kind: "sales_tax_month",
		period: periodText(input.period),
		basis: "order_date",
		currency: REPORT_CURRENCY,
		timeZone: SHOP_TIME_ZONE,
		source: REPORT_SOURCE,
		window: {
			start: input.window.start.toISOString(),
			end: input.window.end.toISOString(),
		},
		business: sales.business,
		channels: sales.channels.map(({ net, ...r }) => ({
			...r,
			proceedsBeforeCost: net,
		})),
		jurisdictions: sales.jurisdictions,
		states: sales.states,
		deposits: sales.deposits.map((d) => ({
			...d,
			depositedAt: d.depositedAt.toISOString(),
		})),
		payoutErrors: sales.payoutErrors,
		partial: sales.partial.map((p) => ({
			channel: p.channel,
			firstOrder: p.firstOrder.toISOString(),
		})),
		contribution: {
			orders: t.orders,
			revenue: t.revenue,
			shippingCharged: t.shippingCharged,
			cost: t.cost,
			costUnknown: t.costUnknown,
			costCorrections: t.costCorrections,
			fees: t.fees,
			estimatedFees: t.estimatedFees,
			feesEstimated: t.feesEstimated,
			labels: t.labels,
			labelsMissing: t.labelsMissing,
			labelsStandIn: t.labelsStandIn,
			labelsAwaiting: t.labelsAwaiting,
			postageAdjustments: t.postageAdjustments,
			refunds: t.refunds,
			adjustments: t.adjustments,
			awaitingReturn: t.awaitingReturn,
			contribution: t.profit,
		},
		evidence: input.evidence,
	});
}

function orderedRows<Row>(
	rows: Row[],
	compare: (before: Row, after: Row) => number = () => 0,
): Row[] {
	return [...rows].sort((before, after) => {
		const primary = compare(before, after);
		if (primary !== 0) return primary;
		const left = canonicalJson(before);
		const right = canonicalJson(after);
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

export function orderedReport(data: ReportData): ReportData {
	return {
		...data,
		channels: orderedRows(
			data.channels,
			(before, after) => after.grossSales - before.grossSales,
		),
		jurisdictions: orderedRows(
			data.jurisdictions,
			(before, after) => after.tax - before.tax,
		),
		states: orderedRows(
			data.states,
			(before, after) => after.sales - before.sales,
		),
		deposits: orderedRows(data.deposits, (before, after) =>
			before.depositedAt < after.depositedAt
				? -1
				: before.depositedAt > after.depositedAt
					? 1
					: 0,
		),
		payoutErrors: orderedRows(data.payoutErrors),
		partial: orderedRows(data.partial),
		evidence: orderedRows(data.evidence),
	};
}

export type ContributionFigure =
	| { kind: "complete"; value: number }
	| {
			kind: "estimated";
			value: number;
			feesEstimated: number;
			labelsStandIn: number;
			labelsAwaiting: number;
			awaitingReturn: number;
	  }
	| {
			kind: "unknown";
			ceiling: number;
			costUnknown: number;
			labelsMissing: number;
	  };

export function contributionFigure(c: Contribution): ContributionFigure {
	if (c.costUnknown > 0 || c.labelsMissing > 0)
		return {
			kind: "unknown",
			ceiling: c.contribution,
			costUnknown: c.costUnknown,
			labelsMissing: c.labelsMissing,
		};
	if (
		c.feesEstimated > 0 ||
		c.labelsStandIn > 0 ||
		c.labelsAwaiting > 0 ||
		c.awaitingReturn > 0
	)
		return {
			kind: "estimated",
			value: c.contribution,
			feesEstimated: c.feesEstimated,
			labelsStandIn: c.labelsStandIn,
			labelsAwaiting: c.labelsAwaiting,
			awaitingReturn: c.awaitingReturn,
		};
	return { kind: "complete", value: c.contribution };
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}
