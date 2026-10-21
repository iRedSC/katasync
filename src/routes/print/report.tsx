import { createFileRoute, Link } from "@tanstack/react-router";
import {
	Globe,
	Hand,
	Landmark,
	MapPin,
	ShieldCheck,
	Store,
	Truck,
} from "lucide-react";
import type { ReactNode } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { formatCount, formatMoney } from "#/lib/format";
import { placeName, taxName } from "#/lib/places";
import { cn } from "#/lib/utils";
import {
	type ChannelRow,
	lastMonth,
	parsePeriod,
	periodDays,
	periodName,
	periodText,
	taxedElsewhere,
} from "#/orders/sales-report";
import { getSalesReport } from "#/server/reports";

// The month's sales and sales tax on one or two letter pages, for the
// accountant: what needs a look first, the totals, a row per channel, and
// the tax, owed and not. Rows of zeros are left out. Same numbers as the
// Reports tab.
export const Route = createFileRoute("/print/report")({
	validateSearch: (search: Record<string, unknown>): { period?: string } => {
		const period = String(search.period ?? "");
		return parsePeriod(period) ? { period } : {};
	},
	loaderDeps: ({ search }) => ({
		period: search.period ?? periodText(lastMonth()),
	}),
	loader: ({ deps }) => getSalesReport({ data: { period: deps.period } }),
	head: () => ({ meta: [{ title: "Sales and sales tax report" }] }),
	component: PrintReport,
});

type Data = Awaited<ReturnType<typeof getSalesReport>>;
type Source = ChannelRow["source"];

// Columns in a fixed order, so every report reads the same way.
const SOURCES: [Source, string][] = [
	["shopify", "Shopify online"],
	["retail", "Retail store"],
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

function PrintReport() {
	const d = Route.useLoaderData();
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

			<article className="mx-auto flex max-w-[8.5in] flex-col gap-5 bg-white p-[0.6in] text-[10pt] text-black shadow-card print:max-w-none print:p-0 print:shadow-none">
				<header className="flex items-end justify-between gap-6 border-b-2 border-black pb-2">
					<div>
						<p className="font-semibold">{d.business.name}</p>
						<h1 className="text-[17pt] leading-tight font-bold">
							Sales and Sales Tax, {periodName(period)}
						</h1>
					</div>
					<p className="shrink-0 text-right text-[9pt]">
						{periodDays(period)}
						<br />
						By order date
					</p>
				</header>

				{d.channels.length === 0 ? (
					<p>katasync has no orders in this month.</p>
				) : (
					<>
						<Totals channels={d.channels} />
						<Section icon={Store} title="Sales by channel">
							<Channels rows={d.channels} />
						</Section>
						<div className="grid grid-cols-[3fr_2fr] gap-6">
							<Section icon={Landmark} title="Sales tax you owe">
								<Owed rows={d.jurisdictions} />
							</Section>
							<Section icon={ShieldCheck} title="Paid by marketplaces">
								<PaidByMarketplaces rows={d.channels} />
							</Section>
						</div>
						<Section icon={MapPin} title="Your Shopify sales by state">
							<States rows={d.states} home={home} />
						</Section>
					</>
				)}
			</article>
		</div>
	);
}

function Section({
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

function Totals({ channels }: { channels: ChannelRow[] }) {
	// Each figure's color: what came in, what's kept, what's owed, and tax
	// that was never ours.
	const figures: [string, number, string][] = [
		["Gross sales", sum(channels, (c) => c.grossSales), "border-info-icon"],
		["Net", sum(channels, (c) => c.net), "border-success-icon"],
		[
			"Sales tax you owe",
			sum(channels, (c) => c.ourTax),
			"border-warning-icon",
		],
		[
			"Tax paid by marketplaces",
			sum(channels, (c) => c.marketplaceTax),
			"border-black/25",
		],
	];
	return (
		<dl className="grid break-inside-avoid grid-cols-4 gap-4">
			{figures.map(([label, value, color]) => (
				<div key={label} className={cn("border-t-4 pt-1.5", color)}>
					<dt className="text-[9.5pt]">{label}</dt>
					<dd className="text-[15pt] font-bold tabular-nums">
						{formatMoney(value)}
					</dd>
				</div>
			))}
		</dl>
	);
}

// A plain table: first column text, the rest right-aligned numbers, and a
// bold total row under a rule.
function Table({
	head,
	rows,
	total,
}: {
	head: string[];
	rows: { key: string; cells: ReactNode[] }[];
	total?: ReactNode[];
}) {
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

// One row per channel. Fees take in the marketplace's other adjustments, so
// gross less refunds, fees and labels is net.
function Channels({ rows }: { rows: ChannelRow[] }) {
	const ordered = SOURCES.flatMap(([s, name]) => {
		const r = rows.find((x) => x.source === s);
		return r ? [{ s, name, r }] : [];
	});
	const fees = (r: ChannelRow) => r.fees + r.adjustments;
	const line = (chip: ReactNode, r: Omit<ChannelRow, "source">) => [
		chip,
		formatCount(r.orders),
		formatMoney(r.grossSales),
		formatMoney(r.refunds),
		formatMoney(fees(r as ChannelRow)),
		formatMoney(r.labels),
		formatMoney(r.net),
	];
	const all = (get: (r: ChannelRow) => number) => sum(rows, get);
	return (
		<Table
			head={["", "Orders", "Gross sales", "Refunds", "Fees", "Labels", "Net"]}
			rows={ordered.map(({ s, name, r }) => ({
				key: name,
				cells: line(CHIPS[s], r),
			}))}
			total={
				ordered.length > 1
					? [
							"Total",
							formatCount(all((r) => r.orders)),
							formatMoney(all((r) => r.grossSales)),
							formatMoney(all((r) => r.refunds)),
							formatMoney(all(fees)),
							formatMoney(all((r) => r.labels)),
							formatMoney(all((r) => r.net)),
						]
					: undefined
			}
		/>
	);
}

function Owed({ rows }: { rows: Data["jurisdictions"] }) {
	if (rows.length === 0) return <p>None.</p>;
	return (
		<Table
			head={["", "Rate", "Taxable sales", "Tax"]}
			rows={rows.map((r) => ({
				key: `${r.country}|${r.jurisdiction}|${r.rate}`,
				cells: [
					taxName(r),
					r.rate === null ? "" : `${+(r.rate * 100).toFixed(4)}%`,
					formatMoney(r.taxableSales),
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

function PaidByMarketplaces({ rows }: { rows: ChannelRow[] }) {
	const paid = SOURCES.flatMap(([s, name]) => {
		const r = rows.find((x) => x.source === s);
		return r && r.marketplaceTax !== 0
			? [{ s, name, tax: r.marketplaceTax }]
			: [];
	});
	if (paid.length === 0) return <p>None.</p>;
	return (
		<Table
			head={["", "Tax"]}
			rows={paid.map((p) => ({
				key: p.name,
				cells: [CHIPS[p.s], formatMoney(p.tax)],
			}))}
			total={
				paid.length > 1
					? ["Total", formatMoney(sum(paid, (p) => p.tax))]
					: undefined
			}
		/>
	);
}

// How a sale reached the buyer, as a chip.
const HOW: Record<
	Data["states"][number]["how"],
	{ icon: typeof Store; label: string }
> = {
	shipped: { icon: Truck, label: "Shipped" },
	in_store: { icon: Store, label: "Retail store" },
	no_address: { icon: Hand, label: "Picked up" },
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
