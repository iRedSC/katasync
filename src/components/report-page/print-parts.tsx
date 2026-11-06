import type { Store } from "lucide-react";
import type { ReactNode } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { KatasyncTax, StatementResult } from "#/reports/statements/types";
import {
	type ChannelSummaryRow,
	channelSummary,
	STATEMENT_NAME,
	statementCaveat,
	statementView,
} from "#/reports/statements/view";

// Pieces of the printed sales report (src/routes/print/report.tsx): its
// plain tables and each marketplace's own figures.

export function Section({
	icon: Icon,
	title,
	children,
}: {
	icon: typeof Store;
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="break-inside-avoid">
			<h2 className="mb-1 flex items-center gap-2 text-[12pt] font-bold">
				<Icon className="size-[1.1em] text-muted-foreground" />
				{title}
			</h2>
			{children}
		</section>
	);
}

// A plain table: first column text, the rest right-aligned numbers, and a
// bold total row under a rule.
export type TableProps = {
	head: string[];
	rows: { key: string; cells: ReactNode[] }[];
	total?: ReactNode[];
};

// Lines a table takes below its heading.
const lines = (t: TableProps) => t.rows.length + (t.total ? 1 : 0);

// Two tables side by side, the shorter padded with blank lines above its
// total so both end level. Each says what to print instead of a table.
export type Side = {
	icon: typeof Store;
	title: string;
	table: TableProps | null;
	empty?: string;
};

export function SideBySide({ left, right }: { left: Side; right: Side }) {
	const tall = Math.max(
		...[left.table, right.table].map((t) => (t ? lines(t) : 0)),
	);
	return [left, right].map((s) => (
		<Section key={s.title} icon={s.icon} title={s.title}>
			{s.table ? (
				<Table {...s.table} height={tall} />
			) : (
				<p>{s.empty ?? "None."}</p>
			)}
		</Section>
	));
}

export function Table({
	head,
	rows,
	total,
	height = 0,
}: TableProps & { height?: number }) {
	const blanks = Array.from(
		{ length: Math.max(0, height - lines({ head, rows, total })) },
		(_, i) => `blank-${i}`,
	);
	const cell = (i: number) =>
		cn(
			"py-0.5",
			i === 0
				? "pr-2 text-left"
				: "pl-2 text-right whitespace-nowrap tabular-nums",
		);
	return (
		<table className="w-full border-collapse">
			<thead>
				<tr className="border-b border-black text-[9.5pt]">
					{head.map((h, i) => (
						<th key={h} className={cn(cell(i), "font-semibold")}>
							{h}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((r) => (
					<tr key={r.key}>
						{r.cells.map((c, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
							<td key={i} className={cell(i)}>
								{c}
							</td>
						))}
					</tr>
				))}
				{blanks.map((key) => (
					<tr key={key}>
						<td className={cell(0)} colSpan={head.length}>
							{/* An unseen chip, so the line is exactly as tall as the others. */}
							<span className="invisible" aria-hidden="true">
								<ChannelBadge channel="amazon" salesChannel={null} />
							</span>
						</td>
					</tr>
				))}
				{total && (
					<tr className="border-t border-black font-bold">
						{total.map((c, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
							<td key={i} className={cell(i)}>
								{c}
							</td>
						))}
					</tr>
				)}
			</tbody>
		</table>
	);
}

// The chip for a row of Shopify's report: the channel the order came in on.
export function salesChannelChip(label: string) {
	return label === "TikTok" ? (
		<ChannelBadge channel="tiktok" salesChannel={null} label="TikTok" />
	) : (
		<ChannelBadge channel="shopify" salesChannel={label} label={label} />
	);
}

// One marketplace's figures, in its own words and order.
export function StatementBlock({ r }: { r: StatementResult }) {
	// On paper, just whose figures and, when they aren't the month's, a word
	// saying so. Why a read failed is on the Reports tab.
	const caveat = r.state === "missing" ? "Not read" : statementCaveat(r);
	const head = (
		<div className="flex items-baseline gap-2">
			<ChannelBadge
				channel={r.channel}
				salesChannel={null}
				label={STATEMENT_NAME[r.channel]}
			/>
			{caveat && (
				<span className="text-[9pt] font-medium text-critical-text">
					{caveat}
				</span>
			)}
		</div>
	);
	if (r.state === "missing")
		return <div className="break-inside-avoid">{head}</div>;
	const view = statementView(r.statement);
	return (
		<div className="break-inside-avoid">
			{head}
			{view.kind === "table" ? (
				<>
					<Table
						head={["", ...view.columns.map((c) => c.label)]}
						rows={view.rows.map((row) => ({
							key: row.label,
							cells: [
								salesChannelChip(row.label),
								...row.cells.map((n, i) =>
									view.columns[i].count ? formatCount(n) : formatMoney(n),
								),
							],
						}))}
						total={[
							"Total",
							...view.total.map((n, i) =>
								view.columns[i].count ? formatCount(n) : formatMoney(n),
							),
						]}
					/>
					{view.callouts.map((l) => (
						<p
							key={l.label}
							className="mt-1 flex justify-between border-l-4 border-[#25f4ee] pl-2"
						>
							<span>{l.label}</span>
							<span className="font-bold tabular-nums">
								{formatMoney(l.amount)}
							</span>
						</p>
					))}
				</>
			) : (
				<div className="grid grid-cols-2 gap-x-6">
					{view.sections.map((sec, k) => (
						<Table
							// biome-ignore lint/suspicious/noArrayIndexKey: sections are positional
							key={k}
							head={[sec.title ?? "", ""]}
							rows={sec.lines.map((l) => ({
								key: l.label,
								cells: [l.label, formatMoney(l.amount)],
							}))}
							total={
								sec.total
									? [sec.total.label, formatMoney(sec.total.amount)]
									: undefined
							}
						/>
					))}
				</div>
			)}
		</div>
	);
}

const dash = (n: number | null, fmt: (n: number) => string) =>
	n === null ? "–" : fmt(n);

// The overview's one row per channel, from each marketplace's own figures.
export function ChannelSummary({
	results,
	katasync,
}: {
	results: StatementResult[];
	katasync: KatasyncTax;
}) {
	const rows = channelSummary(results, katasync);
	const money = (n: number | null) => dash(n, formatMoney);
	const sum = (get: (r: ChannelSummaryRow) => number | null) =>
		rows.reduce((s, r) => s + (get(r) ?? 0), 0);
	const missing = rows.some((r) => r.state === "missing");
	return (
		<Table
			head={[
				"",
				"Orders",
				"Gross sales",
				"Discounts",
				"Refunds",
				"Net sales",
				"Shipping",
				"Tax",
			]}
			rows={rows.map((r) => ({
				key: `${r.channel}|${r.label}`,
				cells: [
					r.channel === "shopify" ? (
						salesChannelChip(r.label === "Shop app" ? "Shop" : r.label)
					) : (
						<ChannelBadge
							channel={r.channel}
							salesChannel={null}
							label={r.label}
						/>
					),
					...(r.state === "missing"
						? [
								<span key="missing" className="font-medium text-critical-text">
									Not read
								</span>,
								"",
								"",
								"",
								"",
								"",
								"",
							]
						: [
								dash(r.orders, formatCount),
								money(r.grossSales),
								money(r.discounts),
								money(r.refunds),
								money(r.netSales),
								money(r.shipping),
								money(r.tax),
							]),
				],
			}))}
			total={[
				missing ? "Total so far" : "Total",
				"",
				formatMoney(sum((r) => r.grossSales)),
				formatMoney(sum((r) => r.discounts)),
				formatMoney(sum((r) => r.refunds)),
				formatMoney(sum((r) => r.netSales)),
				formatMoney(sum((r) => r.shipping)),
				formatMoney(sum((r) => r.tax)),
			]}
		/>
	);
}
