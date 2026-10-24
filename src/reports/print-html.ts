import { channelName, formatCount } from "#/lib/format";
import { placeName, taxName } from "#/lib/places";
import {
	formatAmount,
	parsePeriod,
	payoutTotals,
	periodDays,
	periodName,
	shopDay,
	taxedElsewhere,
} from "#/orders/sales-report";
import { FEE_EVIDENCE } from "./evidence";
import {
	channelTotal,
	contributionStatus,
	FEE_EVIDENCE_NAME,
	HOW_SUFFIX,
	type RevisionMeta,
	sourceName,
} from "./files";
import {
	contributionFigure,
	RENDERER_VERSION,
	type ReportData,
} from "./snapshot";

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};
export const escapeHtml = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

type Html = { readonly html: string };
const raw = (html: string): Html => ({ html });
const text = (v: string | number | null | Html) =>
	v === null
		? ""
		: typeof v === "object"
			? v.html
			: escapeHtml(typeof v === "number" ? formatCount(v) : v);

function table(
	head: string[],
	rows: (string | number | null | Html)[][],
	total?: (string | number | null | Html)[],
) {
	if (rows.length === 0) return "<p>None.</p>";
	const tr = (cells: (string | number | null | Html)[], tag: "td" | "th") =>
		`<tr>${cells.map((c) => `<${tag}>${text(c)}</${tag}>`).join("")}</tr>`;
	return `<table><thead>${tr(head, "th")}</thead><tbody>${rows.map((r) => tr(r, "td")).join("")}${total ? tr(total, "td").replace("<tr>", '<tr class="total">') : ""}</tbody></table>`;
}

const section = (title: string, body: string) =>
	`<section><h2>${escapeHtml(title)}</h2>${body}</section>`;

const STYLE = `@page{size:letter;margin:0.6in}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font:10pt/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#000;margin:0;padding:0.4in;background:#fff}header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #000;padding-bottom:6px}h1{font-size:17pt;margin:0}h2{font-size:12pt;margin:18px 0 4px}p{margin:4px 0}dl.totals{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}dl.totals div{border-top:4px solid #999;padding-top:4px}dl.totals dd{margin:0;font-size:15pt;font-weight:700}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th{font-weight:600;border-bottom:1px solid #000}th,td{padding:2px 6px;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left;white-space:normal}tr.total td{border-top:1px solid #000;font-weight:700}.flag{color:#b42318;font-weight:600}footer{margin-top:20px;border-top:1px solid #999;padding-top:6px;font-size:8pt;color:#333;word-break:break-all}section{break-inside:avoid}`;

export function printHtml(d: ReportData, meta: RevisionMeta): string {
	const usd = (n: number | null) => formatAmount(n, d.currency);
	const period = parsePeriod(d.period);
	const title = `Sales and Sales Tax, ${period ? periodName(period) : d.period}`;
	const all = channelTotal(d.channels);
	const c = d.contribution;
	const figure = contributionFigure(c);
	const asOf = new Intl.DateTimeFormat("en-US", {
		timeZone: d.timeZone,
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(meta.asOf));

	const totals = [
		["Gross sales", usd(all.grossSales)],
		["Proceeds before product cost", usd(all.proceedsBeforeCost)],
		["Sales tax you collected", usd(all.ourTax)],
		["Tax paid by marketplaces", usd(all.marketplaceTax)],
	]
		.map(
			([label, value]) =>
				`<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
		)
		.join("");

	const channelLine = (name: string, r: typeof all) => [
		name,
		r.orders,
		usd(r.grossSales),
		usd(r.refunds),
		usd(r.fees + r.adjustments),
		usd(r.labels),
		usd(r.postageAdjustments),
		usd(r.proceedsBeforeCost),
	];
	const channels = table(
		[
			"",
			"Orders",
			"Gross sales",
			"Refunds",
			"Fees",
			"Labels",
			"Postage",
			"Proceeds before cost",
		],
		d.channels.map((r) => channelLine(sourceName(r.source), r)),
		d.channels.length > 1 ? channelLine("Total", all) : undefined,
	);

	const owed = table(
		["", "Rate", "Sales on taxed orders", "Tax"],
		d.jurisdictions.map((r) => [
			taxName(r),
			r.rate === null ? "" : `${+(r.rate * 100).toFixed(4)}%`,
			usd(r.taxedSales),
			usd(r.tax),
		]),
		d.jurisdictions.length > 1
			? ["Total", "", "", usd(d.jurisdictions.reduce((s, r) => s + r.tax, 0))]
			: undefined,
	);

	const paid = table(
		["", "Tax", "Orders tax not read"],
		d.channels
			.filter((r) => r.marketplaceTax !== 0 || r.taxUnknown > 0)
			.map((r) => [sourceName(r.source), usd(r.marketplaceTax), r.taxUnknown]),
	);

	const currencies = [...new Set(d.deposits.map((r) => r.currency))];
	const deposits = table(
		["", "Sent", "On its way", "Failed"],
		currencies.flatMap((currency) =>
			[...new Set(d.deposits.map((r) => r.channel))].flatMap((channel) => {
				const mine = d.deposits.filter(
					(r) => r.channel === channel && r.currency === currency,
				);
				if (mine.length === 0) return [];
				const t = payoutTotals(mine);
				const failed = mine.filter((r) => r.status === "failed").length;
				return [
					[
						`${channelName(channel)} (${currency})`,
						formatAmount(t.sent, currency),
						formatAmount(t.pending, currency),
						failed,
					],
				];
			}),
		),
	);

	const states = table(
		["", "Orders", "Sales", "Tax"],
		d.states.map((r) => {
			const where = `${placeName(r)}${HOW_SUFFIX[r.how]}`;
			return [
				taxedElsewhere(r, d.business.homeState)
					? raw(`<span class="flag">${escapeHtml(where)}</span>`)
					: where,
				r.orders,
				usd(r.sales),
				usd(r.tax),
			];
		}),
	);

	const contribution = table(
		["Shipped orders", "Amount"],
		[
			["Orders", c.orders],
			["Item sales and shipping", usd(c.revenue + c.shippingCharged)],
			["Product cost", usd(-c.cost)],
			["Cost corrections on goods already sold", usd(-c.costCorrections)],
			["Fees", usd(-c.fees)],
			["Labels and postage", usd(-c.labels - c.postageAdjustments)],
			["Refunds and adjustments", usd(-c.refunds - c.adjustments)],
		],
		[
			"Contribution before overhead",
			figure.kind === "unknown" ? "Unknown" : usd(figure.value),
		],
	);

	const evidence = table(
		["", "Evidence", "Orders", "Fees"],
		d.evidence.flatMap((r) =>
			FEE_EVIDENCE.filter((e) => r.fees[e].orders > 0).map((e) => [
				channelName(r.soldOn),
				FEE_EVIDENCE_NAME[e],
				r.fees[e].orders,
				usd(r.fees[e].amount),
			]),
		),
	);

	const notes = [
		...d.partial.map(
			(p) =>
				`No ${channelName(p.channel)} orders before ${shopDay(new Date(p.firstOrder))}`,
		),
		...d.payoutErrors.map(
			(e) => `${channelName(e.channel)} deposits not read: ${e.error}`,
		),
	]
		.map((n) => `<p class="flag">${escapeHtml(n)}</p>`)
		.join("");

	const footer = [
		`Revision ${meta.revision}, as of ${asOf} (${d.timeZone})`,
		`Amounts in ${d.currency} unless marked`,
		"Tax as each marketplace reported it; not a filing",
		`Schema ${d.schemaVersion}, renderer ${RENDERER_VERSION}`,
		`Source: ${d.source}`,
		`Data digest ${meta.dataDigest}`,
	]
		.map(escapeHtml)
		.join(" · ");

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>
<header><div><p><strong>${escapeHtml(d.business.name ?? "")}</strong></p><h1>${escapeHtml(title)}</h1></div><p style="text-align:right">${escapeHtml(period ? periodDays(period) : d.period)}<br>By order date<br>Revision ${meta.revision}</p></header>
${notes}
<dl class="totals">${totals}</dl>
${section("Sales by channel", channels)}
${section("Sales tax you collected", owed)}
${section("Tax paid by marketplaces", paid)}
${section("Payouts from marketplaces", deposits)}
${section("Shopify sales by state", states)}
${section("Contribution", `${contribution}<p>${escapeHtml(contributionStatus(d))}</p>`)}
${section("Fee evidence", evidence)}
<footer>${footer}</footer>
</body></html>
`;
}
