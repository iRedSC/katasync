import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, Card } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type {
	ListingState,
	MarketDetail,
	ProductInfo,
} from "#/markets/analytics";

// The lists on a market's tab. Each row is a product to act on, with the
// chips that say why: its listing here, and whether we have any to sell.

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

// Each chip says on hover what it means, since "ended" or "shows 0" alone
// doesn't say where the problem is.
const LISTING_TIPS = {
	none: "No listing for this product on this marketplace.",
	ended:
		"Its listing here can't sell: the marketplace has it deleted, archived, or inactive, or it's gone from the marketplace's listings.",
	draft: "Its listing here is a draft, so buyers can't see it.",
	shows_zero:
		"The marketplace shows 0 available while we have stock, so it can't sell here.",
} as const;

function Tipped({
	tip,
	tone,
	children,
}: {
	tip: string;
	tone?: "warning" | "critical";
	children: string;
}) {
	return (
		<Tip content={tip}>
			<span className="cursor-help">
				<Badge tone={tone}>{children}</Badge>
			</span>
		</Tip>
	);
}

export function ListingChip({ listing }: { listing: ListingState }) {
	switch (listing.kind) {
		case "none":
			return <Tipped tip={LISTING_TIPS.none}>Not listed here</Tipped>;
		case "ended":
			return (
				<Tipped tip={LISTING_TIPS.ended} tone="warning">
					Ended here
				</Tipped>
			);
		case "draft":
			return (
				<Tipped tip={LISTING_TIPS.draft} tone="warning">
					Draft here
				</Tipped>
			);
		case "live": {
			const p = listing.problem;
			if (!p) return null;
			if (p.kind === "push_blocked")
				return (
					<Tipped
						tip="Automatic stock writes are blocked; this quantity is observed, not synchronized."
						tone="critical"
					>
						Stock sync blocked
					</Tipped>
				);
			if (p.kind === "shows_zero")
				return (
					<Tipped tip={LISTING_TIPS.shows_zero} tone="critical">
						Shows 0 here
					</Tipped>
				);
			return p.kind === "push_failed" ? (
				<Tipped
					tip={`katasync couldn't set its stock: ${p.error}`}
					tone="critical"
				>
					Stock push failed
				</Tipped>
			) : (
				<Tipped
					tip={`katasync can't set its stock: ${p.reason}`}
					tone="warning"
				>
					Can't set stock
				</Tipped>
			);
		}
	}
}

function StockChip({ available }: { available: number }) {
	return available > 0 ? null : (
		<Tipped tip="None on our shelves to sell." tone="critical">
			Out of stock
		</Tipped>
	);
}

function Row({
	p,
	sub,
	chips,
	figure,
}: {
	p: ProductInfo;
	sub: ReactNode;
	chips?: ReactNode;
	figure: ReactNode;
}) {
	return (
		<li className="border-t first:border-t-0">
			<Link
				to="/products/$sku"
				params={{ sku: p.sku }}
				className="flex items-center gap-3 px-4 py-2.5 hover:bg-subtle"
			>
				<ProductImage src={p.imageUrl} className="size-9" />
				<div className="min-w-0 flex-1">
					<ProductName name={p.name} variantName={p.variantName} />
					<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
						{sub}
						{chips}
					</div>
				</div>
				<div className="text-right tabular-nums">{figure}</div>
			</Link>
		</li>
	);
}

function List({
	title,
	tone,
	aside,
	children,
}: {
	title: string;
	tone?: "warning" | "critical";
	aside?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Card title={title} tone={tone} aside={aside} flush>
			<ul className="border-t">{children}</ul>
		</Card>
	);
}

function Change({ now, before }: { now: number; before: number }) {
	if (before === 0) return <span className="text-xs text-info-text">New</span>;
	const change = (now - before) / before;
	if (Math.abs(change) < 0.05) return null;
	const Icon = change > 0 ? ArrowUp : ArrowDown;
	return (
		<Tip content={`${formatCount(before)} the period before`}>
			<span
				className={cn(
					"inline-flex items-center text-xs",
					change > 0 ? "text-success-text" : "text-critical-text",
				)}
			>
				<Icon className="size-3" />
				{pct(Math.abs(change))}
			</span>
		</Tip>
	);
}

export function BestSellers({ rows }: { rows: MarketDetail["best"] }) {
	return (
		<List title="Best sellers here">
			{rows.map((p) => (
				<Row
					key={p.productId}
					p={p}
					sub={
						<>
							{formatCount(p.units)} sold
							<Change now={p.units} before={p.unitsBefore} />
						</>
					}
					chips={
						<>
							<ListingChip listing={p.listing} />
							<StockChip available={p.available} />
						</>
					}
					figure={
						<>
							<div className="font-semibold">{formatMoney(p.revenue)}</div>
							<div
								className={cn(
									"text-xs",
									p.profit < 0 ? "text-critical-text" : "text-muted-foreground",
								)}
							>
								{formatMoney(p.profit)} profit
							</div>
						</>
					}
				/>
			))}
		</List>
	);
}

export function ToFix({
	rows,
	count,
}: {
	rows: MarketDetail["toFix"];
	count: number;
}) {
	if (rows.length === 0) return null;
	return (
		<List title="Listings to fix" tone="critical" aside={formatCount(count)}>
			{rows.map((p) => (
				<Row
					key={p.productId}
					p={p}
					sub={`${formatCount(p.available)} on hand`}
					chips={<ListingChip listing={p.listing} />}
					figure={
						<Tip content="Sold here, this period and the one before">
							<span className="text-muted-foreground">
								{formatMoney(p.revenue)}
							</span>
						</Tip>
					}
				/>
			))}
		</List>
	);
}

export function Unlisted({ rows }: { rows: MarketDetail["unlisted"] }) {
	if (rows.length === 0) return null;
	return (
		<List title="Sells elsewhere, not here">
			{rows.map((p) => (
				<Row
					key={p.productId}
					p={p}
					sub={
						<>
							{formatCount(p.units)} sold on
							{p.soldOn.map((m) => (
								<ChannelBadge key={m} channel={m} salesChannel={null} compact />
							))}
						</>
					}
					chips={
						<>
							<ListingChip listing={p.listing} />
							<StockChip available={p.available} />
						</>
					}
					figure={<div className="font-semibold">{formatMoney(p.revenue)}</div>}
				/>
			))}
		</List>
	);
}

export function Losing({ rows }: { rows: MarketDetail["losing"] }) {
	if (rows.length === 0) return null;
	return (
		<List title="Losing money here" tone="warning">
			{rows.map((p) => (
				<Row
					key={p.productId}
					p={p}
					sub={`${formatCount(p.units)} sold for ${formatMoney(p.revenue)}`}
					chips={
						p.marginElsewhere !== null && (
							<Badge tone={p.marginElsewhere > 0 ? "success" : undefined}>
								{pct(p.marginElsewhere)} margin elsewhere
							</Badge>
						)
					}
					figure={
						<span className="font-semibold text-critical-text">
							{formatMoney(p.profit)}
							{p.unsure > 0 && (
								<Tip
									content={`${formatCount(p.unsure)} sales still wait on a cost`}
								>
									<span className="ml-1 text-warning-text">≈</span>
								</Tip>
							)}
						</span>
					}
				/>
			))}
		</List>
	);
}

export function Slipping({ rows }: { rows: MarketDetail["slipping"] }) {
	if (rows.length === 0) return null;
	return (
		<List title="Selling less here">
			{rows.map((p) => (
				<Row
					key={p.productId}
					p={p}
					sub={`${formatCount(p.unitsBefore)} the period before`}
					chips={
						<>
							<ListingChip listing={p.listing} />
							<StockChip available={p.available} />
						</>
					}
					figure={
						<span className="font-semibold text-critical-text">
							{formatCount(p.units)} sold
						</span>
					}
				/>
			))}
		</List>
	);
}

export function Returned({ rows }: { rows: MarketDetail["returned"] }) {
	if (rows.length === 0) return null;
	return (
		<List
			title="Returned more here"
			aside={
				<Link to="/orders/returns/insights" className="hover:underline">
					Insights
				</Link>
			}
		>
			{rows.map((p) => (
				<Row
					key={p.productId}
					p={p}
					sub={`${formatCount(p.ordersReturned)} of ${formatCount(p.orders)} orders`}
					chips={
						<Badge>
							{p.rateElsewhere === null
								? "Few sales elsewhere"
								: `${pct(p.rateElsewhere)} elsewhere`}
						</Badge>
					}
					figure={
						<span className="font-semibold text-critical-text">
							{pct(p.rate)}
						</span>
					}
				/>
			))}
		</List>
	);
}
