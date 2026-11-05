import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Download, Receipt } from "lucide-react";
import type { ReactNode } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Card, EmptyState, Page } from "#/components/page";
import { downloadText } from "#/components/report-page/download";
import { History, PrintButton } from "#/components/report-page/revisions";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { channelName, formatCount, formatMoney } from "#/lib/format";
import { placeName, taxName } from "#/lib/places";
import { cn } from "#/lib/utils";
import {
	type ChannelRow,
	type Deposit,
	formatAmount,
	lastMonth,
	type Period,
	parsePeriod,
	payoutProblem,
	payoutTotals,
	periodName,
	periodText,
	shiftPeriod,
	shopDayLabel,
	shopTime,
} from "#/orders/sales-report";
import { type CsvFile, csvFile } from "#/reports/files";
import type { ReportData } from "#/reports/snapshot";
import { getReportPage } from "#/server/reports";

// Sales and sales tax for the accountant, a month at a time, by order date. Each table downloads as CSV. Tax a marketplace paid
// to the state is kept apart from tax we owe, so neither is filed twice.

export const Route = createFileRoute("/reports")({
	// No period means last month, what's usually asked for.
	// A year typed into the address arrives as a number.
	validateSearch: (search: Record<string, unknown>): { period?: string } => {
		const period = String(search.period ?? "");
		return parsePeriod(period) ? { period } : {};
	},
	loaderDeps: ({ search }) => ({
		period: search.period ?? periodText(lastMonth()),
	}),
	loader: ({ deps }) => getReportPage({ data: { period: deps.period } }),
	component: Reports,
	pendingComponent: () => (
		<ListSkeleton title="Reports">
			<ListCard rows={5} />
			<ListCard rows={3} />
		</ListSkeleton>
	),
});

type Data = Awaited<ReturnType<typeof getReportPage>>;

const SOURCES: Record<ChannelRow["source"], ReactNode> = {
	shopify: <ChannelBadge channel="shopify" salesChannel="Online Store" />,
	retail: <ChannelBadge channel="shopify" salesChannel="Point of Sale" />,
	shop: <ChannelBadge channel="shopify" salesChannel="Shop" label="Shop app" />,
	amazon: <ChannelBadge channel="amazon" salesChannel={null} />,
	ebay: <ChannelBadge channel="ebay" salesChannel={null} />,
	tiktok: <ChannelBadge channel="tiktok" salesChannel={null} />,
};

function Reports() {
	const d = Route.useLoaderData();
	const { period: text } = Route.useSearch();
	const period = parsePeriod(text ?? "") ?? lastMonth();
	const partial = d.partial.map((p) => (
		<Flag key={p.channel} tone="critical">
			No {channelName(p.channel)} orders before{" "}
			{p.firstOrder.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
			})}
		</Flag>
	));

	return (
		<Page
			title="Reports"
			width="wide"
			actions={
				<>
					<PeriodPicker period={period} />
					<PrintButton
						period={periodText(period)}
						revisions={d.revisions}
						live={d.live.data}
						liveState={d.liveState}
					/>
				</>
			}
		>
			<Tiles
				channels={d.channels}
				deposits={d.deposits}
				failing={d.payoutErrors.length > 0}
			/>
			{d.channels.length === 0 ? (
				<>
					{partial}
					<EmptyState
						icon={Receipt}
						title={`No orders in ${periodName(period)}`}
					/>
				</>
			) : (
				<>
					<Channels
						rows={d.channels}
						live={d.live.data}
						period={period}
						notes={partial}
					/>
					<div className="grid items-start gap-4 lg:grid-cols-2">
						<Jurisdictions
							rows={d.jurisdictions}
							live={d.live.data}
							period={period}
							unread={d.channels
								.filter((c) => c.source === "shopify" || c.source === "retail")
								.reduce((n, c) => n + c.taxUnknown, 0)}
						/>
						<States
							rows={d.states}
							live={d.live.data}
							period={period}
							notes={d.taxedElsewhere.map((s) => (
								<Flag key={`${s.country}|${s.state}|${s.how}`} tone="critical">
									Shopify charged {placeName(s)} tax on{" "}
									{formatCount(s.taxedOrders)}{" "}
									{s.how === "shipped" ? "shipped" : "picked up"}{" "}
									{s.taxedOrders === 1 ? "order" : "orders"}:{" "}
									{formatMoney(s.tax)}
								</Flag>
							))}
						/>
					</div>
				</>
			)}
			{/* Cash is its own section: deposits in a month with no sales still count. */}
			<Deposits
				rows={d.deposits}
				live={d.live.data}
				period={period}
				failing={d.payoutErrors.length > 0}
				notes={d.payoutErrors.map((e) => (
					<Flag key={e.channel} tone="warning">
						{payoutProblem(e)}
					</Flag>
				))}
			/>
			<History
				revisions={d.revisions}
				live={d.live.data}
				liveState={d.liveState}
			/>
		</Page>
	);
}

// A problem shown inside the section whose figures it affects.
function Flag({
	tone,
	children,
}: {
	tone: "warning" | "critical";
	children: ReactNode;
}) {
	return (
		<p
			className={cn(
				"rounded-md border-l-4 px-3 py-1.5 font-medium",
				tone === "warning"
					? "border-warning-icon bg-warning-surface text-warning-text"
					: "border-critical-icon bg-critical-surface text-critical-text",
			)}
		>
			{children}
		</p>
	);
}

// The month at a glance: what sold, the tax that's ours, the tax that
// isn't, and what arrived in the bank.
function Tiles({
	channels,
	deposits,
	failing,
}: {
	channels: ChannelRow[];
	deposits: Deposit[];
	failing: boolean;
}) {
	const all = (get: (r: ChannelRow) => number) =>
		channels.reduce((s, r) => s + get(r), 0);
	const unread = all((r) => r.taxUnknown);
	// Currencies don't add up, so each one's total is joined, not summed.
	const paid = (status: "sent" | "pending") =>
		currencies(deposits)
			.filter((c) =>
				deposits.some((r) => r.currency === c && r.status === status),
			)
			.map((c) =>
				formatAmount(
					payoutTotals(deposits.filter((r) => r.currency === c))[status],
					c,
				),
			)
			.join(" + ");
	const tiles: { label: string; value: string; note?: ReactNode }[] = [
		{
			label: "Gross sales",
			value: formatMoney(all((r) => r.grossSales)),
			note: `${formatCount(all((r) => r.orders))} orders`,
		},
		{
			label: "Sales tax you collected",
			value: formatMoney(all((r) => r.ourTax)),
			note: unread > 0 && (
				<span className="text-warning-text">
					Not read yet on {formatCount(unread)}{" "}
					{unread === 1 ? "order" : "orders"}
				</span>
			),
		},
		{
			label: "Tax paid by marketplaces",
			value: formatMoney(all((r) => r.marketplaceTax)),
		},
		{
			label: "Deposits sent",
			value: paid("sent") || formatMoney(0),
			note: failing ? (
				<span className="text-warning-text">Not all read</span>
			) : (
				paid("pending") && `${paid("pending")} on its way`
			),
		},
	];
	return (
		<dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
			{tiles.map((t) => (
				<div key={t.label} className="rounded-xl bg-card p-4 shadow-card">
					<dt className="text-muted-foreground">{t.label}</dt>
					<dd className="mt-1 text-2xl font-bold tabular-nums">{t.value}</dd>
					{t.note && (
						<dd className="mt-1 text-xs text-muted-foreground">{t.note}</dd>
					)}
				</div>
			))}
		</dl>
	);
}

const tab = (active: boolean) =>
	cn(
		"inline-flex h-7 items-center rounded-lg px-2.5 font-medium",
		active
			? "bg-surface-strong text-foreground"
			: "text-muted-foreground hover:bg-surface hover:text-foreground",
	);

function PeriodPicker({ period }: { period: Period }) {
	const to = (p: Period) => ({
		to: "/reports" as const,
		search: { period: periodText(p) },
	});
	return (
		<div className="flex items-center gap-1">
			<Link
				{...to(shiftPeriod(period, -1))}
				className={tab(false)}
				aria-label="Earlier"
			>
				<ChevronLeft className="size-4" />
			</Link>
			<span className="min-w-32 text-center font-semibold tabular-nums">
				{periodName(period)}
			</span>
			<Link
				{...to(shiftPeriod(period, 1))}
				className={tab(false)}
				aria-label="Later"
			>
				<ChevronRight className="size-4" />
			</Link>
		</div>
	);
}

type Column<T> = {
	label: string;
	cell: (row: T) => ReactNode;
	money?: boolean;
	// Neighbouring columns with the same group share a heading above them.
	group?: string;
};

// Runs of neighbouring columns under one heading, blank where there's none.
function groupsOf<T>(columns: Column<T>[]) {
	const runs: { group: string; span: number }[] = [];
	for (const c of columns) {
		const last = runs.at(-1);
		if (last && last.group === (c.group ?? "")) last.span++;
		else runs.push({ group: c.group ?? "", span: 1 });
	}
	return runs;
}

function Table<T>({
	title,
	file,
	live,
	period,
	columns,
	rows,
	totals = [],
	keyOf,
	notes,
}: {
	title: string;
	file: CsvFile;
	live: ReportData;
	period: Period;
	columns: Column<T>[];
	rows: T[];
	totals?: T[];
	keyOf: (row: T) => string;
	// Problems with these figures, shown above them.
	notes?: ReactNode[];
}) {
	const groups = columns.some((c) => c.group) ? groupsOf(columns) : null;
	return (
		<Card
			title={title}
			flush
			aside={
				<Button
					variant="ghost"
					size="xs"
					onClick={() =>
						downloadText(
							`${file}-${periodText(period)}.csv`,
							csvFile(live, file),
							"text/csv;charset=utf-8",
						)
					}
				>
					<Download />
					CSV
				</Button>
			}
		>
			{notes && notes.length > 0 && (
				<div className="flex flex-col gap-2 px-4 pb-3">{notes}</div>
			)}
			<div className="overflow-x-auto">
				<table className="w-full tabular-nums">
					<thead className="text-left text-muted-foreground">
						{groups && (
							<tr>
								{groups.map((g, i) => (
									<th
										// biome-ignore lint/suspicious/noArrayIndexKey: blank groups repeat, and runs never reorder
										key={i}
										colSpan={g.span}
										className={cn(
											"px-4 pt-1 text-center text-xs font-semibold tracking-wide uppercase",
											g.group && "border-b",
										)}
									>
										{g.group}
									</th>
								))}
							</tr>
						)}
						<tr className="border-t">
							{columns.map((c) => (
								<th
									key={c.label}
									className={cn(
										"whitespace-nowrap px-4 py-2 font-medium",
										c.money && "text-right",
									)}
								>
									{c.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={keyOf(r)} className="border-t">
								{columns.map((c) => (
									<td
										key={c.label}
										className={cn(
											"whitespace-nowrap px-4 py-2",
											c.money && "text-right",
										)}
									>
										{c.cell(r)}
									</td>
								))}
							</tr>
						))}
						{totals.map((t, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: totals are rebuilt in a fixed order and have no id
							<tr key={i} className="border-t font-semibold">
								{columns.map((c) => (
									<td
										key={c.label}
										className={cn(
											"whitespace-nowrap px-4 py-2",
											c.money && "text-right",
										)}
									>
										{c.cell(t)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Card>
	);
}

function money<T>(
	label: string,
	get: (r: T) => number,
	group?: string,
): Column<T> {
	return { label, money: true, group, cell: (r) => formatMoney(get(r)) };
}
function count<T>(label: string, get: (r: T) => number): Column<T> {
	return { label, money: true, cell: (r) => formatCount(get(r)) };
}

type ChannelLine =
	| ChannelRow
	| (Omit<ChannelRow, "source"> & { source: "total" });

function Channels({
	rows,
	live,
	period,
	notes,
}: {
	rows: ChannelRow[];
	live: ReportData;
	period: Period;
	notes: ReactNode[];
}) {
	const numbers = Object.keys(rows[0]).filter((k) => k !== "source") as Exclude<
		keyof ChannelRow,
		"source"
	>[];
	const total = {
		source: "total",
		...Object.fromEntries(
			numbers.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)]),
		),
	} as ChannelLine;
	const columns: Column<ChannelLine>[] = [
		{
			label: "Sold on",
			cell: (r) => (r.source === "total" ? "Total" : SOURCES[r.source]),
		},
		count("Orders", (r) => r.orders),
		money("Items", (r) => r.itemSales, "Sales"),
		money("Shipping", (r) => r.shipping, "Sales"),
		money("Gross", (r) => r.grossSales, "Sales"),
		{
			...money("Marketplace paid", (r: ChannelLine) => r.marketplaceTax, "Tax"),
			cell: (r) => <Unread row={r}>{formatMoney(r.marketplaceTax)}</Unread>,
		},
		{
			...money("You collected", (r: ChannelLine) => r.ourTax, "Tax"),
			cell: (r) => <Unread row={r}>{formatMoney(r.ourTax)}</Unread>,
		},
		money("Refunds", (r) => r.refunds, "Costs"),
		{
			...money("Fees", (r: ChannelLine) => r.fees, "Costs"),
			cell: (r) => (
				<>
					{formatMoney(r.fees)}
					{r.feesEstimated > 0 && (
						<Tip
							content={`${formatCount(r.feesEstimated)} estimated until reported`}
						>
							<span className="ml-1 text-warning-text">≈</span>
						</Tip>
					)}
				</>
			),
		},
		money("Labels", (r) => r.labels, "Costs"),
		money("Postage", (r) => r.postageAdjustments, "Costs"),
		money("Adjustments", (r) => r.adjustments, "Costs"),
		money("Proceeds before cost", (r) => r.net),
	];
	return (
		<Table
			title="Sales by marketplace"
			file="sales"
			live={live}
			period={period}
			columns={columns}
			rows={rows}
			totals={rows.length > 1 ? [total] : []}
			keyOf={(r) => r.source}
			notes={notes}
		/>
	);
}

// Marks a tax figure that leaves out orders whose tax isn't read yet.
function Unread({ row, children }: { row: ChannelLine; children: ReactNode }) {
	if (row.taxUnknown === 0) return children;
	return (
		<Tip content={`Not read yet on ${formatCount(row.taxUnknown)} orders`}>
			<span className="text-warning-text">{children} ?</span>
		</Tip>
	);
}

function Jurisdictions({
	rows,
	live,
	period,
	unread,
}: {
	rows: Data["jurisdictions"];
	live: ReportData;
	period: Period;
	// Our own orders whose tax isn't read yet, which could owe some.
	unread: number;
}) {
	if (rows.length === 0)
		return (
			<Card title="Sales tax you collected">
				<p
					className={unread > 0 ? "text-warning-text" : "text-muted-foreground"}
				>
					{unread > 0
						? `Not read yet on ${formatCount(unread)} Shopify orders`
						: `None in ${periodName(period)}`}
				</p>
			</Card>
		);
	return (
		<Table<Data["jurisdictions"][number]>
			title="Sales tax you collected"
			file="sales-tax"
			live={live}
			period={period}
			columns={[
				{
					label: "Jurisdiction",
					cell: (r) => taxName(r),
				},
				{
					label: "Rate",
					money: true,
					cell: (r) =>
						r.rate === null ? "" : `${+(r.rate * 100).toFixed(4)}%`,
				},
				count("Orders", (r) => r.orders),
				money("Sales on taxed orders", (r) => r.taxedSales),
				money("Tax", (r) => r.tax),
			]}
			rows={rows}
			keyOf={(r) => `${r.country}|${r.jurisdiction}|${r.rate}`}
			notes={
				unread > 0
					? [
							<Flag key="unread" tone="warning">
								Not read yet on {formatCount(unread)} Shopify orders
							</Flag>,
						]
					: []
			}
		/>
	);
}

const HOW: Record<Data["states"][number]["how"], string> = {
	shipped: "",
	in_store: " (retail)",
	no_address: " (pickup)",
};

function States({
	rows,
	live,
	period,
	notes,
}: {
	rows: Data["states"];
	live: ReportData;
	period: Period;
	notes: ReactNode[];
}) {
	if (rows.length === 0) return null;
	const where = (r: Data["states"][number]) => `${placeName(r)}${HOW[r.how]}`;
	return (
		<Table<Data["states"][number]>
			title="Your Shopify sales by state"
			file="sales-by-state"
			live={live}
			period={period}
			columns={[
				{ label: "State", cell: where },
				count("Orders", (r) => r.orders),
				money("Sales", (r) => r.sales),
				{
					...money("Tax charged", (r: Data["states"][number]) => r.tax),
					cell: (r) => (
						<span className={cn(r.tax === 0 && "text-muted-foreground")}>
							{formatMoney(r.tax)}
						</span>
					),
				},
			]}
			rows={rows}
			keyOf={(r) => `${r.country}|${r.state}|${r.how}`}
			notes={notes}
		/>
	);
}

const STATUS: Record<Deposit["status"], string> = {
	sent: "Sent",
	pending: "On its way",
	failed: "Failed",
};

// A deposit, or a running total under the deposits. Sent and on its way are
// totalled apart, each currency on its own; failed deposits never arrived, so
// no total includes them.
type DepositLine =
	| Deposit
	| { subtotal: string; amount: number; currency: string };
const isDeposit = (l: DepositLine): l is Deposit => "status" in l;
const currencies = (rows: Deposit[]) => [
	...new Set(rows.map((r) => r.currency)),
];

// What the marketplaces sent in the month, deposit by deposit, with the
// reference the bank statement shows. Dates are the shop's day, and the CSV
// keeps the exact instant beside them. Amounts stay in the currency they were
// paid in.
function Deposits({
	rows,
	live,
	period,
	failing,
	notes,
}: {
	rows: Deposit[];
	live: ReportData;
	period: Period;
	// A marketplace's payouts couldn't be read, so an empty list means unknown.
	failing: boolean;
	notes: ReactNode[];
}) {
	if (rows.length === 0)
		return (
			<Card title="Deposits">
				<div className="flex flex-col gap-2">
					{notes}
					{!failing && (
						<p className="text-muted-foreground">
							None in {periodName(period)}
						</p>
					)}
				</div>
			</Card>
		);
	const subtotals: DepositLine[] = currencies(rows).flatMap((currency) => {
		const mine = rows.filter((r) => r.currency === currency);
		const totals = payoutTotals(mine);
		return [
			{ subtotal: "Sent", amount: totals.sent, currency },
			...(mine.some((r) => r.status === "pending")
				? [{ subtotal: "On its way", amount: totals.pending, currency }]
				: []),
		];
	});
	return (
		<Table<DepositLine>
			title="Deposits"
			file="deposits"
			live={live}
			period={period}
			columns={[
				{
					label: "Date",
					cell: (l) =>
						isDeposit(l) ? shopDayLabel(l.depositedAt) : l.subtotal,
				},
				{
					label: "Time",
					cell: (l) => (isDeposit(l) ? shopTime(l.depositedAt) : null),
				},
				{
					label: "From",
					cell: (l) =>
						isDeposit(l) ? (
							<ChannelBadge channel={l.channel} salesChannel={null} />
						) : null,
				},
				{
					label: "Status",
					cell: (l) =>
						isDeposit(l) ? (
							<span
								className={cn(
									l.status === "pending" && "text-warning-text",
									l.status === "failed" && "text-critical-text",
								)}
							>
								{STATUS[l.status]}
							</span>
						) : null,
				},
				{
					label: "Account",
					cell: (l) => (isDeposit(l) && l.bankTail ? `••${l.bankTail}` : ""),
				},
				{
					label: "Reference",
					cell: (l) => (isDeposit(l) ? (l.reference ?? "") : ""),
				},
				{
					label: "Amount",
					money: true,
					cell: (l) => formatAmount(l.amount, l.currency),
				},
			]}
			rows={rows}
			totals={subtotals}
			notes={notes}
			keyOf={(l) =>
				isDeposit(l)
					? `${l.channel}|${l.depositedAt.toISOString()}|${l.amount}`
					: `${l.subtotal}|${l.currency}`
			}
		/>
	);
}
