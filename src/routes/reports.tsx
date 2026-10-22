import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ChevronLeft,
	ChevronRight,
	Download,
	Printer,
	Receipt,
} from "lucide-react";
import type { ReactNode } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Card, EmptyState, Page } from "#/components/page";
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
	shopDay,
	shopDayLabel,
	shopTime,
} from "#/orders/sales-report";
import { getSalesReport } from "#/server/reports";

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
	loader: ({ deps }) => getSalesReport({ data: { period: deps.period } }),
	component: Reports,
	pendingComponent: () => (
		<ListSkeleton title="Reports">
			<ListCard rows={5} />
			<ListCard rows={3} />
		</ListSkeleton>
	),
});

type Data = Awaited<ReturnType<typeof getSalesReport>>;

const SOURCES: Record<ChannelRow["source"], ReactNode> = {
	shopify: <ChannelBadge channel="shopify" salesChannel="Online Store" />,
	retail: <ChannelBadge channel="shopify" salesChannel="Point of Sale" />,
	shop: <ChannelBadge channel="shopify" salesChannel="Shop" label="Shop app" />,
	amazon: <ChannelBadge channel="amazon" salesChannel={null} />,
	ebay: <ChannelBadge channel="ebay" salesChannel={null} />,
	tiktok: <ChannelBadge channel="tiktok" salesChannel={null} />,
};
const sourceName = (s: ChannelRow["source"]) =>
	s === "retail"
		? "Point of Sale"
		: s === "shop"
			? "Shop app"
			: s === "shopify"
				? "Online Store"
				: channelName(s);

// The marketplace whose history a channel's sales are part of: Shopify's
// store, POS and Shop app all come through Shopify.
const soldOn = (s: ChannelRow["source"]) =>
	s === "retail" || s === "shop" ? "shopify" : s;

function Reports() {
	const d = Route.useLoaderData();
	const { period: text } = Route.useSearch();
	const period = parsePeriod(text ?? "") ?? lastMonth();
	const unknown = d.channels.reduce((n, c) => n + c.taxUnknown, 0);

	return (
		<Page
			title="Reports"
			width="wide"
			actions={
				<>
					<PeriodPicker period={period} />
					<Link
						to="/print/report"
						search={{ period: periodText(period) }}
						target="_blank"
						className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 font-semibold text-white hover:bg-primary-hover"
					>
						<Printer className="size-4" />
						Print
					</Link>
				</>
			}
		>
			{d.partial.map((p) => (
				<p
					key={p.channel}
					className="rounded-lg bg-critical-surface px-3 py-2 font-medium text-critical-text"
				>
					No {channelName(p.channel)} orders before{" "}
					{p.firstOrder.toLocaleDateString("en-US", {
						month: "short",
						day: "numeric",
						year: "numeric",
					})}
				</p>
			))}
			{d.payoutErrors.map((e) => (
				<p
					key={e.channel}
					className="rounded-lg bg-warning-surface px-3 py-2 font-medium text-warning-text"
				>
					{payoutProblem(e)}
				</p>
			))}
			{d.channels.length === 0 ? (
				<EmptyState
					icon={Receipt}
					title={`No orders in ${periodName(period)}`}
				/>
			) : (
				<>
					{unknown > 0 && (
						<p className="rounded-lg bg-warning-surface px-3 py-2 font-medium text-warning-text">
							Tax not read yet on {formatCount(unknown)}{" "}
							{unknown === 1 ? "order" : "orders"}
						</p>
					)}
					{d.taxedElsewhere.map((s) => (
						<p
							key={`${s.country}|${s.state}|${s.how}`}
							className="rounded-lg bg-critical-surface px-3 py-2 font-medium text-critical-text"
						>
							Shopify charged {placeName(s)} tax on {formatCount(s.taxedOrders)}{" "}
							{s.how === "shipped" ? "shipped" : "picked up"}{" "}
							{s.taxedOrders === 1 ? "order" : "orders"}: {formatMoney(s.tax)}
						</p>
					))}
					<Channels rows={d.channels} partial={d.partial} period={period} />
					<Jurisdictions
						rows={d.jurisdictions}
						period={period}
						unread={d.channels
							.filter((c) => c.source === "shopify" || c.source === "retail")
							.reduce((n, c) => n + c.taxUnknown, 0)}
					/>
					<States rows={d.states} period={period} />
				</>
			)}
			{/* Cash is its own section: deposits in a month with no sales still count. */}
			<Deposits
				rows={d.deposits}
				period={period}
				failing={d.payoutErrors.length > 0}
			/>
		</Page>
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

// A table and the CSV that matches it, from the same columns. A csvOnly
// column goes to the CSV alone, for the counts the screen marks in place.
type Column<T> = {
	label: string;
	cell: (row: T) => ReactNode;
	csv: (row: T) => string | number | null;
	money?: boolean;
	csvOnly?: boolean;
};

const cents = (n: number) => n.toFixed(2);
const csvCell = (v: string | number | null) => {
	const s = v === null ? "" : String(v);
	return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

function download<T>(
	name: string,
	columns: Column<T>[],
	rows: T[],
	totals: T[],
) {
	const lines = [
		columns.map((c) => c.label),
		...[...rows, ...totals].map((r) => columns.map((c) => c.csv(r))),
	];
	const blob = new Blob(
		[lines.map((l) => l.map(csvCell).join(",")).join("\n")],
		{
			type: "text/csv",
		},
	);
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `${name}.csv`;
	a.click();
	URL.revokeObjectURL(a.href);
}

function Table<T>({
	title,
	file,
	columns,
	rows,
	totals = [],
	keyOf,
}: {
	title: string;
	file: string;
	columns: Column<T>[];
	rows: T[];
	totals?: T[];
	keyOf: (row: T) => string;
}) {
	const shown = columns.filter((c) => !c.csvOnly);
	return (
		<Card
			title={title}
			flush
			aside={
				<Button
					variant="ghost"
					size="xs"
					onClick={() => download(file, columns, rows, totals)}
				>
					<Download />
					CSV
				</Button>
			}
		>
			<div className="overflow-x-auto">
				<table className="w-full tabular-nums">
					<thead className="text-left text-muted-foreground">
						<tr className="border-t">
							{shown.map((c) => (
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
								{shown.map((c) => (
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
								{shown.map((c) => (
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

function money<T>(label: string, get: (r: T) => number): Column<T> {
	return {
		label,
		money: true,
		cell: (r) => formatMoney(get(r)),
		csv: (r) => cents(get(r)),
	};
}
function count<T>(label: string, get: (r: T) => number): Column<T> {
	return { label, money: true, cell: (r) => formatCount(get(r)), csv: get };
}

type ChannelLine =
	| ChannelRow
	| (Omit<ChannelRow, "source"> & { source: "total" });

function Channels({
	rows,
	partial,
	period,
}: {
	rows: ChannelRow[];
	partial: Data["partial"];
	period: Period;
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
			csv: (r) => (r.source === "total" ? "Total" : sourceName(r.source)),
		},
		count("Orders", (r) => r.orders),
		money("Item sales", (r) => r.itemSales),
		money("Shipping", (r) => r.shipping),
		money("Gross sales", (r) => r.grossSales),
		{
			...money("Tax paid by marketplace", (r: ChannelLine) => r.marketplaceTax),
			cell: (r) => <Unread row={r}>{formatMoney(r.marketplaceTax)}</Unread>,
		},
		{
			...money("Tax you owe", (r: ChannelLine) => r.ourTax),
			cell: (r) => <Unread row={r}>{formatMoney(r.ourTax)}</Unread>,
		},
		money("Refunds", (r) => r.refunds),
		{
			...money("Fees", (r: ChannelLine) => r.fees),
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
		money("Labels", (r) => r.labels),
		money("Postage adjustments", (r) => r.postageAdjustments),
		money("Adjustments", (r) => r.adjustments),
		money("Net", (r) => r.net),
		{
			...count("Tax not read (orders)", (r: ChannelLine) => r.taxUnknown),
			csvOnly: true,
		},
		{
			...count("Fees estimated (orders)", (r: ChannelLine) => r.feesEstimated),
			csvOnly: true,
		},
		{
			label: "No orders before",
			csvOnly: true,
			cell: () => null,
			csv: (r) => {
				if (r.source === "total") return null;
				const channel = soldOn(r.source);
				const p = partial.find((x) => x.channel === channel);
				return p ? shopDay(p.firstOrder) : null;
			},
		},
	];
	return (
		<Table
			title="Sales by marketplace"
			file={`sales-${periodText(period)}`}
			columns={columns}
			rows={rows}
			totals={rows.length > 1 ? [total] : []}
			keyOf={(r) => r.source}
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
	period,
	unread,
}: {
	rows: Data["jurisdictions"];
	period: Period;
	// Our own orders whose tax isn't read yet, which could owe some.
	unread: number;
}) {
	if (rows.length === 0)
		return (
			<Card title="Sales tax you owe">
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
			title="Sales tax you owe"
			file={`sales-tax-${periodText(period)}`}
			columns={[
				{
					label: "Jurisdiction",
					cell: (r) => taxName(r),
					csv: (r) => taxName(r),
				},
				{
					label: "Rate",
					money: true,
					cell: (r) =>
						r.rate === null ? "" : `${+(r.rate * 100).toFixed(4)}%`,
					csv: (r) => r.rate,
				},
				count("Orders", (r) => r.orders),
				money("Sales on taxed orders", (r) => r.taxedSales),
				money("Tax", (r) => r.tax),
			]}
			rows={rows}
			keyOf={(r) => `${r.country}|${r.jurisdiction}|${r.rate}`}
		/>
	);
}

const HOW: Record<Data["states"][number]["how"], string> = {
	shipped: "",
	in_store: " (retail)",
	no_address: " (pickup)",
};

function States({ rows, period }: { rows: Data["states"]; period: Period }) {
	if (rows.length === 0) return null;
	const where = (r: Data["states"][number]) => `${placeName(r)}${HOW[r.how]}`;
	return (
		<Table<Data["states"][number]>
			title="Your Shopify sales by state"
			file={`sales-by-state-${periodText(period)}`}
			columns={[
				{ label: "State", cell: where, csv: where },
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
	period,
	failing,
}: {
	rows: Deposit[];
	period: Period;
	// A marketplace's payouts couldn't be read, so an empty list means unknown.
	failing: boolean;
}) {
	if (rows.length === 0)
		return (
			<Card title="Deposits">
				<p className={failing ? "text-warning-text" : "text-muted-foreground"}>
					{failing ? "Not read yet" : `None in ${periodName(period)}`}
				</p>
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
			file={`deposits-${periodText(period)}`}
			columns={[
				{
					label: "Date",
					cell: (l) =>
						isDeposit(l) ? shopDayLabel(l.depositedAt) : l.subtotal,
					csv: (l) => (isDeposit(l) ? shopDay(l.depositedAt) : l.subtotal),
				},
				{
					label: "Time",
					cell: (l) => (isDeposit(l) ? shopTime(l.depositedAt) : null),
					csv: (l) => (isDeposit(l) ? l.depositedAt.toISOString() : null),
				},
				{
					label: "From",
					cell: (l) =>
						isDeposit(l) ? (
							<ChannelBadge channel={l.channel} salesChannel={null} />
						) : null,
					csv: (l) => (isDeposit(l) ? channelName(l.channel) : null),
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
					csv: (l) => (isDeposit(l) ? STATUS[l.status] : null),
				},
				{
					label: "Account",
					cell: (l) => (isDeposit(l) && l.bankTail ? `••${l.bankTail}` : ""),
					csv: (l) => (isDeposit(l) ? l.bankTail : null),
				},
				{
					label: "Reference",
					cell: (l) => (isDeposit(l) ? (l.reference ?? "") : ""),
					csv: (l) => (isDeposit(l) ? l.reference : null),
				},
				{
					label: "Amount",
					money: true,
					cell: (l) => formatAmount(l.amount, l.currency),
					csv: (l) => cents(l.amount),
				},
				{
					label: "Currency",
					csvOnly: true,
					cell: () => null,
					csv: (l) => l.currency,
				},
			]}
			rows={rows}
			totals={subtotals}
			keyOf={(l) =>
				isDeposit(l)
					? `${l.channel}|${l.depositedAt.toISOString()}|${l.amount}`
					: `${l.subtotal}|${l.currency}`
			}
		/>
	);
}
