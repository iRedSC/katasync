import { createFileRoute, Link } from "@tanstack/react-router";
import {
	Banknote,
	Globe,
	Hand,
	Landmark,
	MapPin,
	ShieldCheck,
	Store,
	Truck,
} from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import {
	ChannelSummary,
	Section,
	SideBySide,
	StatementBlock,
	salesChannelChip,
	Table,
	type TableProps,
} from "#/components/report-page/print-parts";
import { SavedPrint } from "#/components/report-page/saved-print";
import { formatCount, formatMoney } from "#/lib/format";
import { placeName, taxName } from "#/lib/places";
import { cn } from "#/lib/utils";
import {
	type ChannelRow,
	formatAmount,
	lastMonth,
	type Period,
	parsePeriod,
	payoutProblem,
	payoutTotals,
	periodDays,
	periodName,
	periodText,
	taxedElsewhere,
} from "#/orders/sales-report";
import { katasyncTax } from "#/reports/print-html";
import type { StatementChannel } from "#/reports/statements/types";
import { STATEMENT_NAME, statementSummary } from "#/reports/statements/view";
import { getReportArtifact, getSalesReport } from "#/server/reports";

// The month's sales and sales tax on one or two letter pages, for the
// accountant: the totals, each marketplace's own figures as its statement or
// sales report shows them, and the tax, owed and not. Same numbers as the
// Reports tab.
export const Route = createFileRoute("/print/report")({
	validateSearch: (
		search: Record<string, unknown>,
	): { period?: string; snapshot?: number } => {
		const period = String(search.period ?? "");
		const snapshot = Number(search.snapshot);
		return {
			...(parsePeriod(period) ? { period } : {}),
			...(Number.isInteger(snapshot) && snapshot > 0 ? { snapshot } : {}),
		};
	},
	loaderDeps: ({ search }) => ({
		period: search.period ?? periodText(lastMonth()),
		snapshot: search.snapshot,
	}),
	loader: async ({ deps }) =>
		deps.snapshot
			? {
					kind: "saved" as const,
					file: await getReportArtifact({
						data: { snapshotId: deps.snapshot, name: "report.html" },
					}),
				}
			: {
					kind: "live" as const,
					report: await getSalesReport({ data: { period: deps.period } }),
				},
	head: () => ({ meta: [{ title: "Sales and sales tax report" }] }),
	component: PrintPage,
});

type Data = Awaited<ReturnType<typeof getSalesReport>>;

function PrintPage() {
	const loaded = Route.useLoaderData();
	return loaded.kind === "saved" ? (
		<SavedPrint file={loaded.file} />
	) : (
		<PrintReport d={loaded.report} />
	);
}

type Source = ChannelRow["source"];

// Columns in a fixed order, so every report reads the same way.
const SOURCES: [Source, string][] = [
	["shopify", "Online Store"],
	["retail", "Point of Sale"],
	["shop", "Shop app"],
	["amazon", "Amazon"],
	["ebay", "eBay"],
	["tiktok", "TikTok"],
];

// Each channel's chip: its marketplace's logo and color.
const CHIPS: Record<Source, ReactNode> = Object.fromEntries(
	SOURCES.map(([s, name]) => [
		s,
		<ChannelBadge
			key={s}
			channel={s === "retail" || s === "shop" ? "shopify" : s}
			salesChannel={
				s === "retail" ? "Point of Sale" : s === "shop" ? "Shop" : null
			}
			label={name}
		/>,
	]),
) as Record<Source, ReactNode>;

const sum = <T,>(rows: T[], get: (r: T) => number) =>
	rows.reduce((s, r) => s + get(r), 0);

function PrintReport({ d }: { d: Data }) {
	const { period: text } = Route.useSearch();
	const period = parsePeriod(text ?? "") ?? lastMonth();
	const home = d.business.homeState;

	return (
		<div className="min-h-svh bg-surface py-6 print:bg-white print:py-0">
			<style>
				{
					// Browsers leave colors out of prints unless told to keep them.
					"@page { size: letter; margin: 0.6in; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }"
				}
			</style>
			<div className="mx-auto mb-4 flex max-w-[8.5in] items-center justify-between print:hidden">
				<Link
					to="/reports"
					search={{ period: periodText(period) }}
					className="text-muted-foreground hover:text-foreground"
				>
					Back to Reports
				</Link>
				<button
					type="button"
					onClick={() => window.print()}
					className="h-8 rounded-lg bg-primary px-3 font-semibold text-white hover:bg-primary-hover"
				>
					Print
				</button>
			</div>

			<article className="mx-auto max-w-[8.5in] bg-white p-[0.6in] text-[10pt] text-black shadow-card print:max-w-none print:p-0 print:shadow-none">
				<OnePage>
					<Header d={d} period={period} />
					<Totals d={d} />
					<Section icon={Store} title="Sales by channel">
						<ChannelSummary results={d.statements} katasync={katasyncTax(d)} />
					</Section>
					{d.channels.length > 0 && (
						<Section icon={Landmark} title="Sales tax you collected">
							<Owed rows={d.jurisdictions} />
						</Section>
					)}
					{/* Payouts stand apart from sales: a month with deposits and no orders still prints them. */}
					<div className="grid grid-cols-2 gap-6">
						<SideBySide
							left={{
								icon: ShieldCheck,
								title: "Paid by marketplaces",
								table: paidByMarketplaces(d),
							}}
							right={{
								icon: Banknote,
								title: "Payouts from marketplaces",
								table: deposits(d.deposits),
								empty: d.payoutErrors.length > 0 ? "Not read yet" : "None.",
							}}
						/>
					</div>
					{d.payoutErrors.map((e) => (
						<p key={e.channel} className="font-medium">
							{payoutProblem(e)}
						</p>
					))}
					{d.channels.length > 0 && (
						<Section icon={MapPin} title="Your Shopify sales by state">
							<States rows={d.states} home={home} />
						</Section>
					)}
				</OnePage>
			</article>
			{/* Each marketplace's figures line for line, on a page of their own. */}
			<article className="mx-auto mt-6 max-w-[8.5in] break-before-page bg-white p-[0.6in] text-[10pt] text-black shadow-card print:mt-0 print:max-w-none print:p-0 print:shadow-none">
				<OnePage>
					<Header d={d} period={period} subtitle="Marketplace breakdowns" />
					<div className="space-y-4">
						{d.statements.map((r) => (
							<StatementBlock key={r.channel} r={r} />
						))}
					</div>
				</OnePage>
			</article>
		</div>
	);
}

function Header({
	d,
	period,
	subtitle,
}: {
	d: Data;
	period: Period;
	subtitle?: string;
}) {
	return (
		<header className="flex items-end justify-between gap-6 border-b-2 border-black pb-2">
			<div>
				<p className="font-semibold">{d.business.name}</p>
				<h1 className="text-[17pt] leading-tight font-bold">
					{subtitle ?? "Sales and Sales Tax"}, {periodName(period)}
				</h1>
			</div>
			<p className="shrink-0 text-right text-[9pt]">{periodDays(period)}</p>
		</header>
	);
}

// What fits inside the page's margins: letter is 11in tall, less 0.6in top
// and bottom, with a little to spare so rounding never spills a line over.
const PAGE_HEIGHT_PX = (11 - 1.2) * 96 * 0.97;

// Lays the report out, then scales it down just enough to fit one page if a
// busy month (many jurisdictions, many states taxed) runs over. The screen
// shows exactly what prints.
function OnePage({ children }: { children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	const [zoom, setZoom] = useState(1);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		// Fonts and photos arriving later change the height, so keep measuring.
		// offsetHeight is the layout height, before the zoom set here.
		const rescale = () =>
			setZoom(
				el.offsetHeight > PAGE_HEIGHT_PX ? PAGE_HEIGHT_PX / el.offsetHeight : 1,
			);
		rescale();
		const watch = new ResizeObserver(rescale);
		watch.observe(el);
		return () => watch.disconnect();
	}, []);
	return (
		<div className="origin-top" style={{ zoom }}>
			<div ref={ref} className="flex flex-col gap-5">
				{children}
			</div>
		</div>
	);
}

// A figure that needs a marketplace not read yet says which, instead of
// printing a partial sum as if it were the whole.
type Figure =
	| { kind: "amount"; value: number; soFar?: boolean }
	| { kind: "missing"; from: StatementChannel[] };

const figureOf = (
	value: number | null,
	from: StatementChannel[],
	soFar: boolean,
): Figure =>
	value === null ? { kind: "missing", from } : { kind: "amount", value, soFar };

function Totals({ d }: { d: Data }) {
	const summary = statementSummary(d.statements, katasyncTax(d));
	const sent = payoutTotals(
		d.deposits.filter((r) => r.currency === "USD"),
	).sent;
	// Each figure's color: what came in, what's owed, tax that was never
	// ours, and what reached the bank.
	const figures: [string, Figure, string][] = [
		[
			"Net sales",
			figureOf(
				summary.netSales,
				summary.netSalesMissing,
				summary.provisional.length > 0,
			),
			"border-info-icon",
		],
		[
			"Sales tax you collected",
			{ kind: "amount", value: sum(d.channels, (c) => c.ourTax) },
			"border-warning-icon",
		],
		[
			"Tax paid by marketplaces",
			figureOf(
				summary.marketplaceTax,
				summary.taxMissing,
				summary.provisional.length > 0,
			),
			"border-black/25",
		],
		["Paid out", { kind: "amount", value: sent }, "border-success-icon"],
	];
	return (
		<dl className="grid break-inside-avoid grid-cols-4 gap-4">
			{figures.map(([label, f, color]) => (
				<div key={label} className={cn("border-t-4 pt-1.5", color)}>
					<dt className="text-[9.5pt]">{label}</dt>
					<dd className="text-[15pt] font-bold tabular-nums">
						{f.kind === "amount" ? (
							<>
								{formatMoney(f.value)}
								{f.soFar && (
									<span className="ml-1 text-[9pt] font-normal text-warning-text">
										so far
									</span>
								)}
							</>
						) : (
							<span className="text-[10pt] text-critical-text">
								Missing {f.from.map((c) => STATEMENT_NAME[c]).join(", ")}
							</span>
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function Owed({ rows }: { rows: Data["jurisdictions"] }) {
	if (rows.length === 0) return <p>None.</p>;
	return (
		<Table
			head={["", "Rate", "Sales on taxed orders", "Tax"]}
			rows={rows.map((r) => ({
				key: `${r.country}|${r.jurisdiction}|${r.rate}`,
				cells: [
					taxName(r),
					r.rate === null ? "" : `${+(r.rate * 100).toFixed(4)}%`,
					formatMoney(r.taxedSales),
					formatMoney(r.tax),
				],
			}))}
			total={
				rows.length > 1
					? ["Total", "", "", formatMoney(sum(rows, (r) => r.tax))]
					: undefined
			}
		/>
	);
}

// Tax each marketplace collected and pays itself, from its own figures: the
// Shop app's and TikTok's from Shopify's report, Amazon's and eBay's from
// theirs. Tax on our own Shopify sales that someone else paid is Managed
// Markets', on orders it sold abroad for us, so it reads as International.
function paidByMarketplaces(d: Data): TableProps | null {
	const summary = statementSummary(d.statements, katasyncTax(d));
	const chip = (label: string) =>
		label === "Amazon" ? (
			CHIPS.amazon
		) : label === "eBay" ? (
			CHIPS.ebay
		) : label === "International" ? (
			<ChannelBadge
				channel="shopify"
				salesChannel="Online Store"
				label="International"
			/>
		) : (
			salesChannelChip(label === "Shop app" ? "Shop" : label)
		);
	const rows = summary.taxRows.filter((r) => r.amount !== 0);
	if (rows.length === 0 && summary.taxMissing.length === 0) return null;
	return {
		head: ["", "Tax"],
		rows: [
			...rows.map((r) => ({
				key: r.label,
				cells: [chip(r.label), formatMoney(r.amount)],
			})),
			...summary.taxMissing.map((c) => ({
				key: c,
				cells: [
					CHIPS[c === "shopify" ? "shop" : c],
					<span key="tax" className="text-muted-foreground">
						Not read yet
					</span>,
				],
			})),
		],
		total:
			rows.length > 1
				? [
						summary.marketplaceTax === null ? "Total so far" : "Total",
						formatMoney(sum(rows, (r) => r.amount)),
					]
				: undefined,
	};
}

// How a sale reached the buyer, as a chip.
const HOW: Record<
	Data["states"][number]["how"],
	{ icon: typeof Store; label: string }
> = {
	shipped: { icon: Truck, label: "Shipped" },
	in_store: { icon: Store, label: "Retail" },
	no_address: { icon: Hand, label: "Pickup" },
};

const CHIP =
	"inline-flex h-5 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[9pt] font-medium whitespace-nowrap";

// Home state in blue, another state Shopify charged tax in, in red: the
// tax is ours to sort out there. States without tax are gray.
type Place = Data["states"][number];

// Blue for where we file (our state, or a show under a transient license),
// red for tax Shopify charged where we don't, gray for places without tax.
function PlaceChip({
	place,
	tone,
	children,
}: {
	place?: Place;
	tone: "filed" | "flagged" | "untaxed";
	children?: ReactNode;
}) {
	const Icon = place && place.country !== "US" ? Globe : MapPin;
	return (
		<span
			className={cn(
				CHIP,
				tone === "filed" && "bg-info-surface text-info-text",
				tone === "flagged" && "bg-critical-surface text-critical-text",
				tone === "untaxed" && "bg-surface-strong text-muted-foreground",
			)}
		>
			<Icon className="size-3" />
			{children ?? (place ? placeName(place) : "")}
		</span>
	);
}

function HowChip({ how }: { how: Data["states"][number]["how"] }) {
	const { icon: Icon, label } = HOW[how];
	return (
		<span className={cn(CHIP, "bg-surface-strong text-foreground")}>
			<Icon className="size-3" />
			{label}
		</span>
	);
}

// Our state line by line, then anywhere else Shopify charged tax, then
// every place without tax as one line.
function States({ rows, home }: { rows: Place[]; home: string | null }) {
	if (rows.length === 0) return <p>None.</p>;
	const isHome = (r: Place) => r.country === "US" && r.state === home;
	const atHome = rows.filter(isHome);
	const taxed = rows.filter((r) => !isHome(r) && r.tax !== 0);
	const untaxed = rows.filter((r) => !isHome(r) && r.tax === 0);
	const places = new Set(untaxed.map((r) => `${r.country}|${r.state}`)).size;
	const abroad = untaxed.some((r) => r.country !== "US");
	const line = (r: Place, tone: "filed" | "flagged") => ({
		key: `${r.country}|${r.state}|${r.how}`,
		cells: [
			<span key="where" className="flex gap-1">
				<PlaceChip place={r} tone={tone} />
				<HowChip how={r.how} />
			</span>,
			formatCount(r.orders),
			formatMoney(r.sales),
			formatMoney(r.tax),
		],
	});
	return (
		<Table
			head={["", "Orders", "Sales", "Tax"]}
			rows={[
				...atHome.map((r) => line(r, "filed")),
				...taxed.map((r) =>
					line(r, taxedElsewhere(r, home) ? "flagged" : "filed"),
				),
				...(untaxed.length > 0
					? [
							{
								key: "rest",
								cells: [
									<PlaceChip key="where" tone="untaxed">
										{places} other {abroad ? "places" : "states"}, no tax
									</PlaceChip>,
									formatCount(sum(untaxed, (r) => r.orders)),
									formatMoney(sum(untaxed, (r) => r.sales)),
									formatMoney(0),
								],
							},
						]
					: []),
			]}
			total={[
				"Total",
				formatCount(sum(rows, (r) => r.orders)),
				formatMoney(sum(rows, (r) => r.sales)),
				formatMoney(sum(rows, (r) => r.tax)),
			]}
		/>
	);
}

// Who sent it: Shopify pays out for every Shopify channel at once.
const depositorName = (channel: Data["deposits"][number]["channel"]) =>
	channel === "shopify"
		? "Shopify"
		: (SOURCES.find(([s]) => s === channel)?.[1] ?? channel);

// What each marketplace sent in the month, sent and on its way in their own
// columns, so a payout still on its way never reads as paid. Failed ones
// never arrived and are left out. Each currency gets its own rows and totals.
function deposits(rows: Data["deposits"]): TableProps | null {
	const arrived = rows.filter((r) => r.status !== "failed");
	if (arrived.length === 0) return null;
	const lines = [
		...new Map(
			arrived.map((r) => [`${r.channel}|${r.currency}`, r] as const),
		).values(),
	];
	const currencies = [...new Set(arrived.map((r) => r.currency))];
	// A dash where nothing arrived in that status.
	const amount = (
		mine: Data["deposits"],
		status: "sent" | "pending",
		currency: string,
	) =>
		formatAmount(
			mine.some((r) => r.status === status) ? payoutTotals(mine)[status] : null,
			currency,
		);
	// Currencies don't add up, so each one's total is joined, not summed.
	const total = (status: "sent" | "pending") =>
		currencies
			.filter((c) =>
				arrived.some((r) => r.currency === c && r.status === status),
			)
			.map((c) =>
				amount(
					arrived.filter((r) => r.currency === c),
					status,
					c,
				),
			)
			.join(" + ") || formatMoney(null);
	return {
		head: ["", "Sent", "On its way"],
		rows: lines.map((line) => {
			const mine = arrived.filter(
				(r) => r.channel === line.channel && r.currency === line.currency,
			);
			return {
				key: `${line.channel}|${line.currency}`,
				cells: [
					<ChannelBadge
						key="from"
						channel={line.channel}
						salesChannel={null}
						label={depositorName(line.channel)}
					/>,
					amount(mine, "sent", line.currency),
					amount(mine, "pending", line.currency),
				],
			};
		}),
		total:
			lines.length > 1 ? ["Total", total("sent"), total("pending")] : undefined,
	};
}
