import { createFileRoute, Link } from "@tanstack/react-router";
import { Receipt } from "lucide-react";
import type { ReactNode } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Card, EmptyState, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import {
	PROFIT_DEFAULTS,
	ProfitViews,
	RangeTabs,
	rangeSearch,
	searchFor,
} from "#/components/profit-nav";
import { FieldsCard, ListCard, ListSkeleton } from "#/components/skeleton";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Tip } from "#/components/ui/tooltip";
import {
	channelName,
	formatCount,
	formatMoney,
	formatOrderDate,
} from "#/lib/format";
import { cn } from "#/lib/utils";
import type { RangeKey } from "#/orders/profit";
import { getProfit } from "#/server/profit";

// What the business made over a stretch of time, from the order_profit view:
// totals, by marketplace and day, and products ranked. Every figure includes
// orders still waiting on a cost, so totals never silently shrink, and the
// page says how much of it rests on estimates.

const VIEW = "/analytics";
const DEFAULT = PROFIT_DEFAULTS[VIEW];

export const Route = createFileRoute("/analytics")({
	validateSearch: rangeSearch(VIEW),
	loaderDeps: ({ search }) => ({ range: search.range ?? DEFAULT }),
	loader: ({ deps }) => getProfit({ data: { range: deps.range } }),
	component: Profit,
	pendingComponent: () => (
		<ListSkeleton title="Analytics">
			<FieldsCard lines={2} />
			<ListCard rows={4} />
			<div className="grid gap-4 lg:grid-cols-2">
				<ListCard rows={6} picture />
				<ListCard rows={6} picture />
			</div>
		</ListSkeleton>
	),
});

type Data = Awaited<ReturnType<typeof getProfit>>;

const margin = (profit: number, revenue: number) =>
	revenue === 0 ? null : profit / revenue;
const percent = (value: number | null) =>
	value === null ? "—" : `${(value * 100).toFixed(1)}%`;

function Profit() {
	const d = Route.useLoaderData();
	const { range = DEFAULT } = Route.useSearch();
	const t = d.totals;

	return (
		<Page title="Analytics" actions={<ProfitViews view={VIEW} range={range} />}>
			<RangeTabs view={VIEW} range={range} />
			{d.waiting > 0 && (
				<p className="text-muted-foreground">
					Counts confirmed, shipped orders. {formatCount(d.waiting)} more{" "}
					{d.waiting === 1 ? "order waits" : "orders wait"} for payment or
					shipping.
				</p>
			)}

			{t.orders === 0 ? (
				<EmptyState icon={Receipt} title="No orders in this range" />
			) : (
				<>
					<Card flush>
						<dl className="grid grid-cols-2 md:grid-cols-4 md:divide-x">
							<Stat
								label="Profit"
								value={formatMoney(t.profit)}
								change={change(t.profit, d.previous.profit)}
								tone={t.profit < 0 ? "critical" : undefined}
								note={<Unsure totals={t} />}
							/>
							<Stat
								label="Margin"
								value={percent(margin(t.profit, t.revenue))}
							/>
							<Stat
								label="Sales"
								value={formatMoney(t.revenue)}
								change={change(t.revenue, d.previous.revenue)}
							/>
							<Stat
								label="Orders"
								value={formatCount(t.orders)}
								change={change(t.orders, d.previous.orders)}
							/>
						</dl>
					</Card>
					<Breakdown totals={t} range={range} rangeEnd={d.range.end} />
					<Days days={d.days} />
					<Marketplaces rows={d.marketplaces} />
					<div className="grid gap-4 lg:grid-cols-2">
						<Products title="Most profitable" rows={d.best} />
						{d.worst.length > 0 ? (
							<Products title="Lost money" rows={d.worst} />
						) : (
							<Card title="Lost money">
								<p className="text-muted-foreground">
									No product lost money in this range.
								</p>
							</Card>
						)}
					</div>
					<Attention rows={d.attention} />
				</>
			)}
			<StockValue rows={d.stock} />
		</Page>
	);
}

const PLACES = { owned: "Warehouse", retail: "Store", fba: "Amazon FBA" };

// What's on the shelves is worth now, at each product's average cost.
function StockValue({ rows }: { rows: Data["stock"] }) {
	if (rows.length === 0) return null;
	const total = rows.reduce((n, r) => n + r.value, 0);
	const uncosted = rows.reduce((n, r) => n + r.uncosted, 0);
	return (
		<Card
			title="Stock value"
			aside={
				uncosted > 0 && (
					<span className="text-warning-text">
						{formatCount(uncosted)} without a cost
					</span>
				)
			}
		>
			<dl className="grid grid-cols-[1fr_auto_auto] gap-x-6 gap-y-1.5 tabular-nums">
				{rows.map((r) => (
					<div key={r.kind} className="contents">
						<dt className="text-muted-foreground">{PLACES[r.kind]}</dt>
						<dd className="text-right text-muted-foreground">
							{formatCount(r.units)} items
						</dd>
						<dd className="text-right">{formatMoney(r.value)}</dd>
					</div>
				))}
				<dt className="col-span-2 border-t pt-1.5 font-semibold">Total</dt>
				<dd className="border-t pt-1.5 text-right font-semibold">
					{formatMoney(total)}
				</dd>
			</dl>
		</Card>
	);
}

// Against the same stretch of the period before.
function change(now: number, before: number) {
	if (before === 0) return null;
	return (now - before) / Math.abs(before);
}

function Stat({
	label,
	value,
	change,
	tone,
	note,
}: {
	label: string;
	value: string;
	change?: number | null;
	tone?: "critical";
	// What the figure rests on that isn't final.
	note?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1 p-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd
				className={cn(
					"text-xl font-bold tabular-nums",
					tone === "critical" && "text-critical-text",
				)}
			>
				{value}
			</dd>
			{change !== undefined && change !== null && (
				<dd
					className={cn(
						"text-xs tabular-nums",
						change < 0 ? "text-critical-text" : "text-success-text",
					)}
				>
					{change > 0 ? "+" : ""}
					{(change * 100).toFixed(0)}% on the period before
				</dd>
			)}
			{note && <dd>{note}</dd>}
		</div>
	);
}

// Says plainly what the totals rest on that isn't final: a chip under the
// figure, amber when the profit is too high rather than merely provisional,
// opening to the reasons.
function Unsure({ totals: t }: { totals: Data["totals"] }) {
	const notes = [
		t.feesEstimated > 0 &&
			`${formatCount(t.feesEstimated)} orders' fees (${formatMoney(t.estimatedFees)}) are estimates until the marketplace reports them.`,
		t.labelsStandIn > 0 &&
			`${formatCount(t.labelsStandIn)} TikTok labels use katasync's estimate until TikTok bills them.`,
		t.labelsAwaiting > 0 &&
			`${formatCount(t.labelsAwaiting)} shipped orders wait for the marketplace to bill their label.`,
		t.awaitingReturn > 0 &&
			`${formatCount(t.awaitingReturn)} refunded orders' items aren't back yet, so their cost isn't counted until they're written off or 60 days pass.`,
		t.labelsMissing > 0 &&
			`${formatCount(t.labelsMissing)} shipped orders have no label cost from anyone, so their profit is too high.`,
		t.costUnknown > 0 &&
			`${formatCount(t.costUnknown)} orders have a line with no product cost, so their profit is too high.`,
	].filter((n): n is string => typeof n === "string");
	if (notes.length === 0) return null;
	const overstated = t.labelsMissing + t.costUnknown;
	const pending = t.orders - t.complete;
	return (
		<Popover>
			<PopoverTrigger
				className={cn(
					"inline-flex h-5 items-center rounded-md px-1.5 text-xs font-medium",
					overstated > 0
						? "bg-warning-fill text-warning-text"
						: "bg-surface-strong text-muted-foreground",
				)}
			>
				{overstated > 0
					? `Too high on ${formatCount(overstated)} orders`
					: `${formatCount(pending)} orders not final`}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-3">
				<p className="font-semibold">
					{formatMoney(t.completeProfit)} is from the {formatCount(t.complete)}{" "}
					of {formatCount(t.orders)} orders whose costs are all in.
				</p>
				<ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
					{notes.map((n) => (
						<li key={n}>{n}</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

// Carriers re-bill weeks after the sale; Amazon's come up to 60 days on.
const REBILLS_WITHIN_MS = 60 * 24 * 60 * 60 * 1000;

function Breakdown({
	totals: t,
	range,
	rangeEnd,
}: {
	totals: Data["totals"];
	range: RangeKey;
	rangeEnd: Date;
}) {
	const rebillsToCome =
		new Date(rangeEnd).getTime() > Date.now() - REBILLS_WITHIN_MS;
	// Why a row isn't final yet, if it isn't, and where it leads.
	const rows: [ReactNode, number, string?][] = [
		["Sales", t.revenue],
		["Shipping charged", t.shippingCharged],
		[
			"Cost of goods",
			-t.cost,
			t.costUnknown > 0
				? `Missing for ${formatCount(t.costUnknown)} orders`
				: t.awaitingReturn > 0
					? `Leaves out refunded items not back yet, on ${formatCount(t.awaitingReturn)} orders`
					: undefined,
		],
		[
			"Marketplace fees",
			-t.fees,
			t.feesEstimated > 0
				? `Estimated for ${formatCount(t.feesEstimated)} orders`
				: undefined,
		],
		[
			"Shipping labels",
			-t.labels,
			t.labelsStandIn + t.labelsAwaiting + t.labelsMissing > 0
				? `Estimated or missing for ${formatCount(t.labelsStandIn + t.labelsAwaiting + t.labelsMissing)} orders`
				: undefined,
		],
		[
			<Link
				key="postage"
				to="/profit/postage"
				search={searchFor("/profit/postage", range)}
				className="hover:text-foreground hover:underline"
			>
				Postage adjustments
				{t.postageAdjusted > 0 && (
					<span className="ml-1.5 rounded-md bg-critical-fill px-1.5 text-xs font-medium text-critical-text tabular-nums">
						{formatCount(t.postageAdjusted)} orders
					</span>
				)}
			</Link>,
			-t.postageAdjustments,
			rebillsToCome
				? "More may come: carriers re-bill weeks after the sale"
				: undefined,
		],
		["Refunds", -t.refunds],
		["Other adjustments", -t.adjustments],
		// Late freight or a fixed price, on stock that had already sold.
		...(t.costCorrections !== 0
			? [
					["Cost corrections on sold stock", -t.costCorrections] as [
						ReactNode,
						number,
					],
				]
			: []),
	];
	return (
		<Card title="Where it went">
			<dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 tabular-nums">
				{rows.map(([label, amount, unsure], i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, never reordered
					<div key={i} className="contents">
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="text-right">
							{unsure ? (
								<Tip content={unsure}>
									<span className="cursor-help border-b border-dotted border-current">
										≈ {formatMoney(amount)}
									</span>
								</Tip>
							) : (
								formatMoney(amount)
							)}
						</dd>
					</div>
				))}
				<dt className="border-t pt-1.5 font-semibold">Profit</dt>
				<dd className="border-t pt-1.5 text-right font-semibold">
					{formatMoney(t.profit)}
				</dd>
			</dl>
		</Card>
	);
}

// Profit per day as bars, losses below the line.
function Days({ days }: { days: Data["days"] }) {
	if (days.length < 2) return null;
	const top = Math.max(0, ...days.map((d) => d.profit));
	const bottom = Math.min(0, ...days.map((d) => d.profit));
	const span = top - bottom || 1;
	const height = 160;
	const zero = (top / span) * height;
	return (
		<Card title="Profit by day">
			<div className="flex h-[160px] items-stretch gap-px">
				{days.map((d) => {
					const h = (Math.abs(d.profit) / span) * height;
					return (
						<Tip
							key={d.day}
							content={`${formatDay(d.day)}: ${formatMoney(d.profit)} on ${formatMoney(d.revenue)}, ${formatCount(d.orders)} orders`}
						>
							<div className="relative flex-1 hover:bg-subtle">
								<div
									className={cn(
										"absolute inset-x-0 rounded-sm",
										d.profit < 0 ? "bg-critical-fill" : "bg-primary",
									)}
									style={
										d.profit < 0
											? { top: zero, height: h }
											: { top: zero - h, height: h }
									}
								/>
							</div>
						</Tip>
					);
				})}
			</div>
			<div className="mt-1 flex justify-between text-xs text-muted-foreground">
				<span>{formatDay(days[0].day)}</span>
				<span>{formatDay(days[days.length - 1].day)}</span>
			</div>
		</Card>
	);
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});
// Days arrive as the shop's calendar date, "2026-10-15".
const formatDay = (day: string) => dayFormat.format(new Date(`${day}T00:00Z`));

function Marketplaces({ rows }: { rows: Data["marketplaces"] }) {
	return (
		<Card title="By marketplace" flush>
			<table className="w-full tabular-nums">
				<thead className="text-left text-muted-foreground">
					<tr className="border-t">
						<th className="px-4 py-2 font-medium">Sold on</th>
						<th className="px-4 py-2 text-right font-medium">Orders</th>
						<th className="px-4 py-2 text-right font-medium">Sales</th>
						<th className="px-4 py-2 text-right font-medium">Fees</th>
						<th className="px-4 py-2 text-right font-medium">Labels</th>
						<th className="px-4 py-2 text-right font-medium">Profit</th>
						<th className="px-4 py-2 text-right font-medium">Margin</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.soldOn} className="border-t">
							<td className="px-4 py-2">
								<ChannelBadge channel={r.soldOn} salesChannel={null} />
							</td>
							<td className="px-4 py-2 text-right">{formatCount(r.orders)}</td>
							<td className="px-4 py-2 text-right">{formatMoney(r.revenue)}</td>
							<td className="px-4 py-2 text-right">
								{formatMoney(r.fees)}
								{r.feesEstimated > 0 && (
									<Tip
										content={`${formatCount(r.feesEstimated)} orders' fees are estimates until ${channelName(r.soldOn)} reports them`}
									>
										<span className="ml-1 text-warning-text">≈</span>
									</Tip>
								)}
							</td>
							<td className="px-4 py-2 text-right">{formatMoney(r.labels)}</td>
							<td
								className={cn(
									"px-4 py-2 text-right font-semibold",
									r.profit < 0 && "text-critical-text",
								)}
							>
								{formatMoney(r.profit)}
							</td>
							<td className="px-4 py-2 text-right">
								{percent(margin(r.profit, r.revenue))}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</Card>
	);
}

function Products({ title, rows }: { title: string; rows: Data["best"] }) {
	return (
		<Card title={title} flush>
			<ul>
				{rows.map((p) => (
					<li key={p.sku} className="border-t first:border-t-0">
						<Link
							to="/products/$sku"
							params={{ sku: p.sku }}
							className="flex items-center gap-3 px-4 py-2.5 hover:bg-subtle"
						>
							<ProductImage src={p.imageUrl} className="size-9" />
							<div className="min-w-0 flex-1">
								<ProductName name={p.name} variantName={p.variantName} />
								<div className="text-xs text-muted-foreground">
									{p.sku} · {formatCount(p.units)} sold for{" "}
									{formatMoney(p.revenue)}
								</div>
							</div>
							<span
								className={cn(
									"font-semibold tabular-nums",
									p.profit < 0 && "text-critical-text",
								)}
							>
								{formatMoney(p.profit)}
								{p.unsure > 0 && (
									<Tip
										content={`${formatCount(p.unsure)} of its sales still wait on a cost`}
									>
										<span className="ml-1 text-warning-text">≈</span>
									</Tip>
								)}
							</span>
						</Link>
					</li>
				))}
			</ul>
		</Card>
	);
}

// Orders only a person can fix: a label bought somewhere katasync can't see,
// or a product without a cost.
function Attention({ rows }: { rows: Data["attention"] }) {
	if (rows.length === 0) return null;
	return (
		<Card title="Missing a cost" tone="warning" flush>
			<ul>
				{rows.map((o) => (
					<li key={o.id} className="border-t first:border-t-0">
						<Link
							to="/orders/$id"
							params={{ id: String(o.id) }}
							className="flex items-center gap-3 px-4 py-2.5 hover:bg-subtle"
						>
							<ChannelBadge channel={o.soldOn} salesChannel={null} />
							<span className="font-medium">{o.name}</span>
							<span className="flex-1 text-muted-foreground">
								{[
									o.labelsStatus === "missing" && "No label cost",
									!o.costKnown && "A product has no cost",
								]
									.filter(Boolean)
									.join(" · ")}
							</span>
							<span className="text-muted-foreground">
								{formatOrderDate(o.placedAt)}
							</span>
						</Link>
					</li>
				))}
			</ul>
		</Card>
	);
}
