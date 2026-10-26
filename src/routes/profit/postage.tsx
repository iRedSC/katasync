import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, PackageCheck } from "lucide-react";
import { useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Card, EmptyState, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import {
	PROFIT_DEFAULTS,
	ProfitViews,
	RangeTabs,
	rangeSearch,
} from "#/components/profit-nav";
import { ShippingDims } from "#/components/profit-page/shipping-dims";
import { formatBox, poundsOunces } from "#/components/quick-ship/units";
import { RebillReasons } from "#/components/rebill-reasons";
import { ListCard, ListSkeleton } from "#/components/skeleton";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatMoney, formatOrderDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import { amazonOrderLink } from "#/orders/fulfillment";
import type { RebilledOrder } from "#/orders/postage-adjustments";
import { getPostageAdjustments } from "#/server/profit";

// What carriers re-billed for a size or weight other than declared, and
// what to fix: the box contents and products that keep getting re-billed,
// worst first, each with the orders behind it.

const VIEW = "/profit/postage";
const DEFAULT = PROFIT_DEFAULTS[VIEW];

export const Route = createFileRoute("/profit/postage")({
	validateSearch: rangeSearch(VIEW),
	loaderDeps: ({ search }) => ({ range: search.range ?? DEFAULT }),
	loader: ({ deps }) => getPostageAdjustments({ data: { range: deps.range } }),
	component: Postage,
	pendingComponent: () => (
		<ListSkeleton title="Fix postage">
			<ListCard rows={6} picture />
			<ListCard rows={6} picture />
		</ListSkeleton>
	),
});

type Data = Awaited<ReturnType<typeof getPostageAdjustments>>;
// Why Shippo re-billed each order's label, by order ID.
type Why = Data["why"];

const rate = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
const pct = (value: number) => `${Math.round(value * 100)}%`;

function Postage() {
	const d = Route.useLoaderData();
	const { range = DEFAULT } = Route.useSearch();

	return (
		<Page title="Profit" actions={<ProfitViews view={VIEW} range={range} />}>
			<RangeTabs view={VIEW} range={range} />
			{d.rebilled.length === 0 ? (
				<EmptyState icon={PackageCheck} title="Nothing re-billed in this range">
					Carriers re-bill two to eight weeks after the sale.
				</EmptyState>
			) : (
				<>
					<Card flush>
						<dl className="grid grid-cols-1 md:grid-cols-3 md:divide-x">
							<Stat label="Re-billed" value={formatMoney(d.amount)} critical />
							<Stat
								label="Orders re-billed"
								value={`${formatCount(d.rebilled.length)} of ${formatCount(d.orders)}`}
								bar={rate(d.rebilled.length, d.orders)}
							/>
							<Stat
								label="On top of their labels"
								value={`+${pct(rate(d.amount, d.labels))}`}
								sub={`${formatMoney(d.labels)} to begin with`}
							/>
						</dl>
						<p className="border-t px-4 py-2 text-xs text-muted-foreground">
							Amazon names the order, not the box or what the carrier measured,
							so these group by what was in it. Seller Central shows each
							order's package as declared.
						</p>
					</Card>
					{d.byBox.length > 0 && <Boxes groups={d.byBox} why={d.why} />}
					<Contents groups={d.byContents} why={d.why} />
					<Products groups={d.byProduct} unmatched={d.unmatched} why={d.why} />
				</>
			)}
		</Page>
	);
}

function Stat({
	label,
	value,
	sub,
	bar,
	critical,
}: {
	label: string;
	value: string;
	sub?: string;
	// A share, drawn under the figure.
	bar?: number;
	critical?: boolean;
}) {
	return (
		<div className="flex flex-col gap-1 p-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd
				className={cn(
					"text-xl font-bold tabular-nums",
					critical && "text-critical-text",
				)}
			>
				{value}
			</dd>
			{bar !== undefined && <Share value={bar} />}
			{sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
		</div>
	);
}

// How often it's re-billed, as a bar: wider and redder is worse.
function Share({ value }: { value: number }) {
	return (
		<div className="h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-surface-strong">
			<div
				className={cn(
					"h-full rounded-full",
					value >= 0.25 ? "bg-critical-fill" : "bg-warning-fill",
				)}
				style={{ width: `${Math.max(4, Math.min(100, value * 100))}%` }}
			/>
		</div>
	);
}

// Count, share and money of one group, at the right of its row.
function Figures({
	rebilled,
	orders,
	amount,
	labels,
	noun = "orders",
}: {
	rebilled: number;
	orders: number;
	amount: number;
	labels: number;
	// What was counted: orders, or katasync's own labels.
	noun?: string;
}) {
	return (
		<div className="flex shrink-0 items-center gap-4 tabular-nums">
			<Tip
				content={`Re-billed on ${pct(rate(rebilled, orders))} of the ${noun} it shipped in`}
			>
				<div className="flex w-28 flex-col items-end gap-1">
					<span className="text-xs text-muted-foreground">
						{formatCount(rebilled)} of {formatCount(orders)} {noun}
					</span>
					<Share value={rate(rebilled, orders)} />
				</div>
			</Tip>
			<div className="w-24 text-right">
				<div className="font-semibold text-critical-text">
					{formatMoney(amount)}
				</div>
				<div className="text-xs text-muted-foreground">
					+{pct(rate(amount, labels))} on labels
				</div>
			</div>
		</div>
	);
}

// katasync's own labels by the box they went in: a saved box (fixed in
// Settings, where its size and empty weight live) or a size typed for that
// label alone. Each opens to its re-billed labels with the weight declared.
function Boxes({ groups, why }: { groups: Data["byBox"]; why: Why }) {
	return (
		<Card title="By box" flush>
			<ul>
				{groups.map((g) => (
					<li key={g.key} className="border-t first:border-t-0">
						<details>
							<summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 hover:bg-subtle">
								<div className="min-w-0 flex-1">
									<div className="truncate">
										{g.packageId === null
											? "Typed in"
											: (g.name ?? "Saved box")}{" "}
										<span className="text-muted-foreground">
											{formatBox(g.box)}
										</span>
									</div>
									{g.packageId !== null && (
										<Link
											to="/settings"
											className="text-xs text-link hover:underline"
										>
											Fix in Settings
										</Link>
									)}
								</div>
								<Figures
									rebilled={g.rebilled.length}
									orders={g.labels}
									amount={g.amount}
									labels={g.cost}
									noun="labels"
								/>
							</summary>
							<Orders orders={g.rebilled} why={why} />
						</details>
					</li>
				))}
			</ul>
		</Card>
	);
}

function Contents({ groups, why }: { groups: Data["byContents"]; why: Why }) {
	return (
		<Card title="By what was in the box" flush>
			<ul>
				{groups.map((g) => (
					<li key={g.key} className="border-t first:border-t-0">
						<details className="group">
							<summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 hover:bg-subtle">
								<div className="flex -space-x-2">
									{g.items.slice(0, 3).map((item, i) => (
										<ProductImage
											// biome-ignore lint/suspicious/noArrayIndexKey: a box's items, never reordered
											key={i}
											src={item.imageUrl}
											className="size-9 ring-2 ring-background"
										/>
									))}
								</div>
								<div className="min-w-0 flex-1">
									<div className="truncate">
										{g.items
											.map(
												(item) =>
													`${item.quantity > 1 ? `${formatCount(item.quantity)} × ` : ""}${item.name}`,
											)
											.join(" + ")}
									</div>
									<div className="truncate text-xs text-muted-foreground">
										{g.key.replaceAll("|", " · ")}
									</div>
								</div>
								<Figures
									rebilled={g.rebilled.length}
									orders={g.orders}
									amount={g.amount}
									labels={g.labels}
								/>
							</summary>
							<Orders orders={g.rebilled} why={why} />
						</details>
					</li>
				))}
			</ul>
		</Card>
	);
}

function Products({
	groups,
	unmatched,
	why,
}: {
	groups: Data["byProduct"];
	unmatched: number;
	why: Why;
}) {
	return (
		<Card
			title="By product"
			aside={
				unmatched !== 0 && (
					<Tip content="Items with no product in katasync">
						<span className="text-xs text-muted-foreground">
							{formatMoney(unmatched)} on unmatched items
						</span>
					</Tip>
				)
			}
			flush
		>
			<ul>
				{groups.map((p) => (
					<ProductRow key={p.productId} product={p} why={why} />
				))}
			</ul>
		</Card>
	);
}

// A product, how it ships as saved (editable in place), and its re-bills;
// the figures open the orders behind them.
function ProductRow({
	product: p,
	why,
}: {
	product: Data["byProduct"][number];
	why: Why;
}) {
	const [open, setOpen] = useState(false);
	return (
		<li className="border-t first:border-t-0">
			<div className="flex items-center gap-3 px-4 py-2.5">
				<ProductImage src={p.imageUrl} className="size-9" />
				<div className="min-w-0 flex-1">
					{p.sku ? (
						<Link
							to="/products/$sku"
							params={{ sku: p.sku }}
							className="block truncate hover:underline"
						>
							<ProductName name={p.name} variantName={p.variantName} />
						</Link>
					) : (
						<div className="truncate">{p.name}</div>
					)}
					<div className="text-xs text-muted-foreground">
						{p.sku ?? "No SKU"} ·{" "}
						<ShippingDims
							productId={p.productId}
							sku={p.sku}
							weightGrams={p.weightGrams}
							box={p.box}
						/>
					</div>
				</div>
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
					className="rounded-md hover:bg-subtle"
				>
					<Figures
						rebilled={p.rebilled.length}
						orders={p.orders}
						amount={p.amount}
						labels={p.labels}
					/>
				</button>
			</div>
			{open && <Orders orders={p.rebilled} why={why} />}
		</li>
	);
}

// The re-billed orders behind a group, each opening in katasync and, for
// Amazon, on Seller Central where the package as declared is. Orders on
// katasync's own labels say why Shippo re-billed them underneath.
function Orders({
	orders,
	why,
}: {
	orders: (RebilledOrder & { weightGrams?: number; serviceName?: string })[];
	why: Why;
}) {
	return (
		<ul className="border-t bg-subtle px-4 py-1.5">
			{orders.map((o) => (
				<li key={o.id} className="py-1">
					<div className="flex items-center gap-3 text-xs tabular-nums">
						<ChannelBadge channel={o.soldOn} salesChannel={null} compact />
						<Link
							to="/orders/$id"
							params={{ id: String(o.id) }}
							className="font-medium text-link hover:underline"
						>
							{o.name}
						</Link>
						<span className="text-muted-foreground">
							{formatOrderDate(o.placedAt)}
						</span>
						{o.soldOn === "amazon" && o.marketplaceId && (
							<a
								href={amazonOrderLink(o.marketplaceId)}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 text-link hover:underline"
							>
								Seller Central
								<ExternalLink className="size-3" />
							</a>
						)}
						{o.weightGrams !== undefined && (
							<span className="text-muted-foreground">
								declared {poundsOunces(o.weightGrams)} · {o.serviceName}
							</span>
						)}
						<span className="flex-1 text-right text-muted-foreground">
							{o.labels === 0
								? "no label cost"
								: `label ${formatMoney(o.labels)}`}
						</span>
						<span className="w-16 text-right font-medium text-critical-text">
							{formatMoney(o.amount)}
						</span>
					</div>
					<RebillReasons
						rebills={why[o.id] ?? []}
						className="mt-1 ml-8 max-w-md"
					/>
				</li>
			))}
		</ul>
	);
}
