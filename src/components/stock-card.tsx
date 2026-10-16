import { Link } from "@tanstack/react-router";
import { ClipboardList, PackagePlus, Truck } from "lucide-react";
import type { ReactNode } from "react";
import type { Level, NextStep, Trust } from "#/inventory/stock-state";
import { formatCount, formatOrderQuantity } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { ProductRow } from "#/server/catalog";
import { AbcBadge, Badge, type Tone } from "./page";
import { ProductImage } from "./product";
import { fillColor, rangeFill } from "./stock-ring";
import { Button } from "./ui/button";
import { VelocityGauge } from "./velocity-gauge";

export type StockState = {
	trust: Trust;
	level: Level;
	step: NextStep;
	daysLeft: number | null;
};

// Healthy stays quiet; everything else gets a word, and a tone where it's a
// problem.
const LEVEL_BADGE: Record<Level, { label: string; tone?: Tone } | null> = {
	oversold: { label: "Oversold", tone: "critical" },
	"missing parts": { label: "Missing parts", tone: "warning" },
	"sold out": { label: "Sold out" },
	"below min": { label: "Below min", tone: "warning" },
	healthy: null,
	"over max": { label: "Over max", tone: "info" },
};

// A and B products get a 2px outline in their class's color, like native's
// sale cards; C stays plain. The second pixel is a ring outside the card's
// hairline, so nothing inside shrinks.
const ABC_OUTLINE = {
	A: "shadow-[0_0_0_2px_var(--abc-a-line)]",
	B: "shadow-[0_0_0_2px_var(--abc-b-line)]",
	C: "shadow-card",
} as const;

// A product as a tile for deciding what to do: the photo (is this the thing
// I think it is?) beside the stock (do I act?), then trust and the one next
// step along the bottom. The whole tile opens the product; the button does
// its step without leaving the page.
export function StockCard({
	product: p,
	state,
	index,
	selected,
	now,
	onOpen,
	onSelect,
	onOrder,
	onCount,
}: {
	product: ProductRow;
	state: StockState;
	index: number;
	selected: boolean;
	now: Date;
	onOpen: () => void;
	onSelect: () => void;
	onOrder: () => void;
	onCount: () => void;
}) {
	const badge = LEVEL_BADGE[state.level];
	return (
		// biome-ignore lint/a11y/useSemanticElements: holds its own button, so it can't be one
		<div
			role="button"
			tabIndex={-1}
			data-index={index}
			onClick={onOpen}
			onKeyDown={(e) => e.key === "Enter" && onOpen()}
			onMouseMove={onSelect}
			onContextMenu={onSelect}
			className={cn(
				"flex cursor-pointer flex-col gap-2.5 rounded-xl bg-card p-3 text-left",
				p.abc ? ABC_OUTLINE[p.abc] : "shadow-card",
				selected && "outline-2 outline-offset-2 outline-faint",
			)}
		>
			<div className="grid grid-cols-2 gap-3">
				<ProductImage src={p.imageUrl} className="aspect-square w-full" />
				<StockSide product={p} state={state} />
			</div>
			<div className="min-w-0">
				<p className="line-clamp-2 min-h-10 leading-5 font-medium">
					{p.name}
					{p.variantName && (
						<span className="text-muted-foreground"> {p.variantName}</span>
					)}
				</p>
				<p className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
					<span className="shrink-0">{p.sku}</span>
					<span aria-hidden="true">·</span>
					<span className="truncate">
						{p.kind === "bundle" && "Tool set from "}
						{p.supplier?.name ?? "No supplier"}
					</span>
				</p>
			</div>
			<div className="flex items-center gap-2">
				<AbcBadge
					abc={p.abc}
					title={
						p.abcRank === null
							? "Needs a cost to get a class"
							: p.kind === "bundle"
								? `#${formatCount(p.abcRank)} of tool sets by value`
								: `#${formatCount(p.abcRank)} by value`
					}
				/>
				{badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
				{p.why && (
					<span className="-my-2 ml-auto">
						<VelocityGauge why={p.why} onPo={p.draft ?? undefined} />
					</span>
				)}
			</div>
			{/* Trust and the step share the foot, wrapping before they'd overflow. */}
			<div className="mt-auto flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-t pt-2.5">
				<TrustLine trust={state.trust} now={now} />
				<Step step={state.step} onOrder={onOrder} onCount={onCount} />
			</div>
		</div>
	);
}

function StockSide({
	product: p,
	state,
}: {
	product: ProductRow;
	state: StockState;
}) {
	// A tool set's stock is how many its parts can build.
	const set = p.kind === "bundle";
	const onHand = set ? p.available : (p.onHand ?? 0);
	const oversold = onHand < 0;
	return (
		<div className="flex min-w-0 flex-col justify-between">
			<div>
				<Big critical={oversold} muted={onHand === 0}>
					{formatCount(onHand)}
				</Big>
				<span className="mt-1 block text-xs text-muted-foreground">
					{set
						? "Built from its parts"
						: state.daysLeft === null
							? "No sales in 90 days"
							: state.daysLeft === 0
								? "Out now"
								: `Lasts ~${formatCount(state.daysLeft)} ${state.daysLeft === 1 ? "day" : "days"}`}
				</span>
			</div>
			<div className="flex flex-col gap-1">
				<StockBar onHand={onHand} onOrder={p.onOrder} range={p.range} />
				<span className="text-xs text-muted-foreground tabular-nums">
					Keep {formatCount(p.range.min)} to {formatCount(p.range.max)}
				</span>
				{p.onOrder > 0 && (
					<span className="text-xs text-link tabular-nums">
						+{formatCount(p.onOrder)} coming
					</span>
				)}
			</div>
		</div>
	);
}

function Big({
	critical = false,
	muted = false,
	children,
}: {
	critical?: boolean;
	muted?: boolean;
	children: ReactNode;
}) {
	return (
		<span
			className={cn(
				"block text-3xl leading-none font-bold tabular-nums",
				critical && "text-critical-text",
				muted && !critical && "text-faint",
			)}
		>
			{children}
		</span>
	);
}

// On hand along a track that ends at max, in the stock ring's colors, with
// what's coming striped on after it. The tick marks min.
export function StockBar({
	onHand,
	onOrder,
	range,
}: {
	onHand: number;
	onOrder: number;
	range: { min: number; max: number };
}) {
	const share = (n: number) => Math.min(Math.max(n / range.max, 0), 1) * 100;
	const filled = share(onHand);
	const coming = share(onHand + onOrder) - filled;
	return (
		<div
			className="relative h-2 overflow-hidden rounded-sm bg-surface-strong"
			title={`${formatCount(onHand)} on hand${onOrder > 0 ? `, ${formatCount(onOrder)} coming` : ""}. Keep ${formatCount(range.min)} to ${formatCount(range.max)}`}
		>
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
	);
}

// One word; when it was counted is in the tooltip.
function TrustLine({ trust, now }: { trust: Trust; now: Date }) {
	if (trust.kind === "counted") {
		const days = Math.floor((now.getTime() - trust.at.getTime()) / 86_400_000);
		return (
			<p
				className="text-xs font-medium text-success-text"
				title={`Counted ${days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`}`}
			>
				Counted
			</p>
		);
	}
	return <p className="text-xs text-muted-foreground">Uncounted</p>;
}

// The card's one button. Steps that need nothing from you show as text.
function Step({
	step,
	onOrder,
	onCount,
}: {
	step: NextStep;
	onOrder: () => void;
	onCount: () => void;
}) {
	const stop = (run: () => void) => (e: React.MouseEvent) => {
		e.stopPropagation();
		run();
	};
	switch (step.kind) {
		case "order":
			return (
				<Button size="sm" onClick={stop(onOrder)}>
					<PackagePlus />
					Add {formatOrderQuantity(step)} to PO
				</Button>
			);
		case "count":
			return (
				<Button size="sm" variant="outline" onClick={stop(onCount)}>
					<ClipboardList />
					Count stock
				</Button>
			);
		case "count requested":
			return (
				<span className="text-xs font-medium text-muted-foreground">
					Count requested
				</span>
			);
		case "on draft":
			return (
				<Link
					to="/purchasing/$id"
					params={{ id: String(step.purchaseOrderId) }}
					onClick={(e) => e.stopPropagation()}
					className="inline-flex items-center gap-1 text-xs font-medium text-link hover:underline"
				>
					<Truck className="size-3.5" />
					On PO {step.purchaseOrderId}
				</Link>
			);
		case "set supplier":
			return (
				<span className="text-xs font-medium text-warning-text">
					Needs a supplier
				</span>
			);
		case "none":
			return null;
	}
}
