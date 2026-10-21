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
					<Contents groups={d.byContents} />
					<Products groups={d.byProduct} unmatched={d.unmatched} />
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
}: {
	rebilled: number;
	orders: number;
	amount: number;
	labels: number;
}) {
	return (
		<div className="flex shrink-0 items-center gap-4 tabular-nums">
			<Tip
				content={`Re-billed on ${pct(rate(rebilled, orders))} of the orders it shipped in`}
			>
				<div className="flex w-28 flex-col items-end gap-1">
					<span className="text-xs text-muted-foreground">
						{formatCount(rebilled)} of {formatCount(orders)} orders
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

function Contents({ groups }: { groups: Data["byContents"] }) {
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
							<Orders orders={g.rebilled} />
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
}: {
	groups: Data["byProduct"];
	unmatched: number;
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
					<ProductRow key={p.productId} product={p} />
				))}
			</ul>
		</Card>
	);
}

// A product, how it ships as saved (editable in place), and its re-bills;
// the figures open the orders behind them.
function ProductRow({ product: p }: { product: Data["byProduct"][number] }) {
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
			{open && <Orders orders={p.rebilled} />}
		</li>
	);
}

// The re-billed orders behind a group, each opening in katasync and, for
// Amazon, on Seller Central where the package as declared is.
function Orders({ orders }: { orders: RebilledOrder[] }) {
	return (
		<ul className="border-t bg-subtle px-4 py-1.5">
			{orders.map((o) => (
				<li
					key={o.id}
					className="flex items-center gap-3 py-1 text-xs tabular-nums"
				>
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
					<span className="flex-1 text-right text-muted-foreground">
						{o.labels === 0
							? "no label cost"
							: `label ${formatMoney(o.labels)}`}
					</span>
					<span className="w-16 text-right font-medium text-critical-text">
						{formatMoney(o.amount)}
					</span>
				</li>
			))}
		</ul>
	);
}
