import { Link } from "@tanstack/react-router";
import {
	ClipboardList,
	Library,
	Loader2,
	PackagePlus,
	Truck,
} from "lucide-react";
import {
	type ComponentProps,
	type ReactNode,
	type SyntheticEvent,
	useState,
} from "react";
import { AbcBadge, Badge, type Tone } from "#/components/page";
import { ProductImage, ProductName, SetsChip } from "#/components/product";
import { AddToCatalog } from "#/components/products-list/add-to-catalog";
import { setCatalogOnAll } from "#/components/products-list/bulk-actions";
import { fillColor, rangeFill } from "#/components/stock-ring";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import {
	afterArrival,
	type Level,
	type NextStep,
	type Trust,
} from "#/inventory/stock-state";
import { formatCount, formatMoney, formatOrderQuantity } from "#/lib/format";
import { cn } from "#/lib/utils";
import { stock } from "#/products/rows";
import type { ProductRow } from "#/server/catalog";

// What each column of the product table shows for one product. Healthy rows
// stay quiet, so problems stand out when scanning down a column.

export function ProductCell({ product: p }: { product: ProductRow }) {
	return (
		<div className="flex items-center gap-3">
			<ProductImage src={p.imageUrl} />
			<div className="min-w-0 flex-1">
				<ProductName name={p.name} variantName={p.variantName} />
				<div className="flex min-w-0 items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
					<span className="truncate">{p.sku}</span>
					<SetsChip sets={p.why?.sets ?? null} />
					{p.kind === "bundle" && <span>Tool set</span>}
					{p.kind === "kit" && <span>Kit</span>}
				</div>
			</div>
		</div>
	);
}

export function ClassCell({ product: p }: { product: ProductRow }) {
	return (
		<AbcBadge
			abc={p.abc}
			title={
				p.abcRank === null
					? "Needs a cost"
					: p.kind === "bundle"
						? `#${formatCount(p.abcRank)} of tool sets by value`
						: `#${formatCount(p.abcRank)} by value`
			}
		/>
	);
}

const LEVEL_BADGE: Record<Level, { label: string; tone?: Tone } | null> = {
	oversold: { label: "Oversold", tone: "critical" },
	"missing parts": { label: "Missing parts", tone: "warning" },
	"sold out": { label: "Sold out" },
	"below min": { label: "Below min", tone: "warning" },
	healthy: null,
	"over max": { label: "Over max", tone: "info" },
};

export function LevelCell({ level }: { level: Level }) {
	const badge = LEVEL_BADGE[level];
	return badge && <Badge tone={badge.tone}>{badge.label}</Badge>;
}

// The number to act on, over a bar of where it sits between min and max.
export function StockCell({ product: p }: { product: ProductRow }) {
	const n = stock(p);
	const set = p.kind === "bundle";
	return (
		<div className="flex w-full flex-col gap-1">
			<span
				className={cn(
					"tabular-nums",
					n < 0 && "font-semibold text-critical-text",
					n === 0 && "text-faint",
				)}
			>
				{formatCount(n)}
				{set && (
					<span className="text-xs text-muted-foreground"> can build</span>
				)}
			</span>
			<StockBar
				onHand={n}
				onOrder={p.onOrder}
				range={p.range}
				noun={set ? "can build" : "on hand"}
			/>
		</div>
	);
}

// On hand along a track that ends at max, in the stock ring's colors, with
// what's coming striped on after it. The tick marks min.
export function StockBar({
	onHand,
	onOrder,
	range,
	noun = "on hand",
}: {
	onHand: number;
	onOrder: number;
	range: { min: number; max: number };
	// What the number counts, for the tooltip.
	noun?: "on hand" | "can build";
}) {
	const share = (n: number) => Math.min(Math.max(n / range.max, 0), 1) * 100;
	const filled = share(onHand);
	const coming = share(afterArrival(onHand, onOrder)) - filled;
	return (
		<Tip
			content={`${formatCount(onHand)} ${noun}${onOrder > 0 ? `, ${formatCount(onOrder)} coming` : ""}. Keep ${formatCount(range.min)} to ${formatCount(range.max)}`}
		>
			<div className="relative h-1.5 overflow-hidden rounded-sm bg-surface-strong">
				<div
					className="absolute inset-y-0 left-0"
					style={{
						width: `${filled}%`,
						background:
							onHand < 0
								? "var(--critical-icon)"
								: fillColor(rangeFill(onHand, range)),
					}}
				/>
				{coming > 0 && (
					<div
						className="absolute inset-y-0 bg-[repeating-linear-gradient(45deg,var(--primary)_0_2px,transparent_2px_5px)] opacity-60"
						style={{ left: `${filled}%`, width: `${coming}%` }}
					/>
				)}
				<div
					className="absolute inset-y-0 w-px bg-foreground/40"
					style={{ left: `${share(range.min)}%` }}
				/>
			</div>
		</Tip>
	);
}

export function RangeCell({ product: p }: { product: ProductRow }) {
	return (
		<span className="text-muted-foreground tabular-nums">
			{formatCount(p.range.min)}–{formatCount(p.range.max)}
		</span>
	);
}

// Days of stock at the recent rate: red within a week, amber within a month.
export function RunsOutCell({ days }: { days: number | null }) {
	if (days === null) return <span className="text-faint">No sales</span>;
	return (
		<span
			className={cn(
				"tabular-nums",
				days <= 7 && "font-medium text-critical-text",
				days > 7 && days <= 30 && "text-warning-text",
			)}
		>
			{days === 0 ? "Out" : `${formatCount(days)} d`}
		</span>
	);
}

export function NumberCell({
	n,
	money = false,
}: {
	n: number | null;
	money?: boolean;
}) {
	if (n === null) return <span className="text-faint">—</span>;
	return (
		<span className={cn("tabular-nums", n === 0 && "text-faint")}>
			{money ? formatMoney(n) : formatCount(n)}
		</span>
	);
}

// The suggested order, or the line already waiting on a draft.
export function ReorderCell({ product: p }: { product: ProductRow }) {
	if (p.draft) {
		return (
			<span className="block max-w-50 truncate text-muted-foreground">
				{formatOrderQuantity(p.draft)} on PO {p.draft.purchaseOrderId}
			</span>
		);
	}
	if (p.reorder) {
		return (
			<span className="block max-w-50 truncate font-medium">
				{formatOrderQuantity(p.reorder)}
			</span>
		);
	}
	return null;
}

// One word; when it was counted is in the tooltip.
export function TrustCell({ trust, now }: { trust: Trust; now: Date }) {
	if (trust.kind === "counted") {
		return (
			<Tip content={`Counted ${ago(trust.at, now)}`}>
				<span className="text-xs font-medium text-success-text">Counted</span>
			</Tip>
		);
	}
	const asked = trust.requested && (
		<span className="text-xs text-muted-foreground"> · asked</span>
	);
	if (trust.kind === "not counted")
		return (
			<Tip content="Sells without limit on every channel until it's counted">
				<span className="text-xs font-medium text-warning-text">
					Not counted{asked}
				</span>
			</Tip>
		);
	return <span className="text-xs text-muted-foreground">Stale{asked}</span>;
}

export function CountedCell({ at, now }: { at: Date | null; now: Date }) {
	if (!at) return <span className="text-faint">Never</span>;
	return <span className="tabular-nums">{ago(at, now)}</span>;
}

function ago(at: Date, now: Date) {
	const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
	return days === 0
		? "today"
		: days === 1
			? "yesterday"
			: `${formatCount(days)} days ago`;
}

// Every step's button is this wide, so the column stays one width.
const STEP_BUTTON = "w-36 justify-start";

// The row's one next step as a button, or a link to the PO it's already on.
export function StepCell({
	product,
	step,
	busy,
	onOrder,
	onCount,
}: {
	product: ProductRow;
	step: NextStep;
	busy: boolean;
	onOrder: () => void;
	onCount: () => void;
}) {
	switch (step.kind) {
		case "order":
			return (
				<Tip content={`Add ${formatOrderQuantity(step)} to PO`}>
					<StepButton disabled={busy} onClick={onOrder} icon={<PackagePlus />}>
						Add {formatOrderQuantity(step)} to PO
					</StepButton>
				</Tip>
			);
		case "count":
		case "count requested":
			return (
				<StepButton
					disabled={step.kind === "count requested"}
					onClick={onCount}
					icon={<ClipboardList />}
				>
					Count Stock
				</StepButton>
			);
		case "on draft":
			return (
				<Link
					to="/purchasing/$id"
					params={{ id: String(step.purchaseOrderId) }}
					className="inline-flex items-center gap-1.5 px-2.5 text-[0.8125rem] font-medium text-link hover:underline"
				>
					<Truck className="size-4" />
					In PO #{step.purchaseOrderId}
				</Link>
			);
		case "add catalog":
			return <CatalogStep product={product} />;
		case "none":
			return null;
	}
}

function StepButton({
	icon,
	children,
	...props
}: {
	icon: ReactNode;
	children: ReactNode;
} & ComponentProps<"button">) {
	return (
		<Button size="sm" variant="outline" className={STEP_BUTTON} {...props}>
			{icon}
			<span className="truncate">{children}</span>
		</Button>
	);
}

// Picks a catalog for the product, whose suppliers then sell it. The picker
// and its dialog live in portals, so their clicks are kept from the row,
// which would open the product.
function CatalogStep({ product }: { product: ProductRow }) {
	const [busy, setBusy] = useState(false);
	const stop = (e: SyntheticEvent) => e.stopPropagation();
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: only stops events from reaching the row
		<span
			className="contents"
			onClick={stop}
			onKeyDown={stop}
			onContextMenu={stop}
			onAuxClick={stop}
		>
			<AddToCatalog
				picked={[product]}
				disabled={false}
				busy={busy}
				onAdd={async (c) => {
					setBusy(true);
					try {
						await setCatalogOnAll([product], c);
					} finally {
						setBusy(false);
					}
				}}
				trigger={(t) => (
					<Button
						size="sm"
						variant="outline"
						className={STEP_BUTTON}
						disabled={t.disabled || t.busy}
					>
						{t.busy ? <Loader2 className="animate-spin" /> : <Library />}
						<span className="truncate">Add Catalog</span>
					</Button>
				)}
			/>
		</span>
	);
}

export function TagsCell({ tags }: { tags: string[] }) {
	if (tags.length === 0) return null;
	const shown = tags.slice(0, 3);
	return (
		<Tip content={tags.length > 3 ? tags.join(", ") : undefined}>
			<span className="flex max-w-64 flex-wrap gap-1">
				{shown.map((t) => (
					<span
						key={t}
						className="rounded-md bg-surface px-1.5 text-xs text-muted-foreground"
					>
						{t}
					</span>
				))}
				{tags.length > 3 && (
					<span className="text-xs text-muted-foreground">
						+{formatCount(tags.length - 3)}
					</span>
				)}
			</span>
		</Tip>
	);
}

const LISTING_TONE: Record<string, Tone | undefined> = {
	active: "success",
	draft: "warning",
};

export function ListingCell({ status }: { status: string | null }) {
	if (!status) return <span className="text-faint">Not listed</span>;
	const s = status.toLowerCase();
	return (
		<Badge tone={LISTING_TONE[s]}>{s[0].toUpperCase() + s.slice(1)}</Badge>
	);
}
