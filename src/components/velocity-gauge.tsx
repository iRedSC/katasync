import { HoverCard } from "radix-ui";
import type { ReactNode } from "react";
import { Tip } from "#/components/ui/tooltip";
import { afterArrival } from "#/inventory/stock-state";
import { formatCount, formatOrderQuantity, formatUnit } from "#/lib/format";
import { cn } from "#/lib/utils";
import { DEMAND_DAYS } from "#/purchasing/forecast";
import type { ReorderWhy } from "#/purchasing/reorder";

// Sized like StockRing, so the two line up side by side.
const HOLE = 28;
const STROKE = 5;
const SIZE = HOLE + 2 * STROKE;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Slow sellers are a cool blue, the fastest a hot magenta. Kept clear of the
// stock ring's orange to green, so the two never read as the same scale.
const rankColor = (rank: number) =>
	`oklch(${0.62 - 0.04 * rank} ${0.13 + 0.07 * rank} ${245 + rank * 95})`;

// The pieces of the breakdown, in the order they stack in the bars.
const COLORS = {
	restock: "oklch(0.62 0.15 255)",
	safety: "oklch(0.72 0.14 300)",
	cover: "oklch(0.8 0.08 255)",
	min: "oklch(0.7 0.12 75)",
	shelf: "var(--success-icon)",
	coming: "var(--info-icon)",
	late: "oklch(0.8 0.12 75)",
	unmet: "oklch(0.62 0.2 25)",
	order: "var(--primary)",
} as const;

// Units a month in at most four characters: 120, 12, 3.5, 0.3, <0.1.
export function monthlyText(dailyDemand: number) {
	const m = dailyDemand * 30;
	if (m === 0) return "0";
	if (m < 0.05) return "<0.1";
	if (m >= 1000)
		return new Intl.NumberFormat("en-US", {
			notation: "compact",
			maximumSignificantDigits: 2,
		}).format(m);
	if (m >= 10) return String(Math.round(m));
	return String(Math.round(m * 10) / 10);
}

const minus = (n: number) => (n === 0 ? "0" : `−${formatCount(n)}`);

const plural = (n: number, one: string, many = `${one}s`) =>
	`${formatCount(n)} ${n === 1 ? one : many}`;

// The product's line on a draft PO, to compare with what reorder suggests.
type OnPo = {
	quantity: number;
	unit: string;
	packSize: number;
	supplierCount: number;
	purchaseOrderId?: number;
};

// How fast a product sells, as units a month in a ring filled by how it ranks
// against everything else that sells. Hovering or focusing it opens why
// reorder wants what it does. `onPo` is this PO's line, when there is one,
// so the card can say how it compares.
export function VelocityGauge({
	why,
	onPo,
}: {
	why: ReorderWhy | null;
	onPo?: OnPo;
}) {
	if (!why)
		return (
			<Tip content="Tool sets are ordered as their parts; each part has its own velocity">
				<span className="block text-center text-muted-foreground">—</span>
			</Tip>
		);
	return (
		<HoverCard.Root openDelay={150} closeDelay={100}>
			<HoverCard.Trigger asChild>
				<button
					type="button"
					aria-label={`${monthlyText(why.dailyDemand)} sold a month. Show why`}
					className="mx-auto flex w-fit cursor-help rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
					// The row behind opens the product; this only explains.
					onClick={(e) => e.stopPropagation()}
				>
					<Ring why={why} />
				</button>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side="left"
					align="center"
					sideOffset={8}
					collisionPadding={12}
					// Clicks inside bubble through React to the row, which would open
					// the product.
					onClick={(e) => e.stopPropagation()}
					className="z-50 w-84 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-black/10"
				>
					<Explanation why={why} onPo={onPo} />
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

function Ring({ why }: { why: ReorderWhy }) {
	const fill = why.rank === null ? 0 : Math.max(why.rank, 0.04);
	const text = monthlyText(why.dailyDemand);
	return (
		<span
			className="relative inline-flex shrink-0 items-center justify-center"
			style={{ width: SIZE, height: SIZE }}
		>
			<svg
				width={SIZE}
				height={SIZE}
				className="absolute inset-0 -rotate-90"
				aria-hidden="true"
			>
				<circle
					cx={SIZE / 2}
					cy={SIZE / 2}
					r={RADIUS}
					fill="none"
					stroke="var(--surface-strong)"
					strokeWidth={STROKE}
				/>
				{fill > 0 && (
					<circle
						cx={SIZE / 2}
						cy={SIZE / 2}
						r={RADIUS}
						fill="none"
						stroke={rankColor(fill)}
						strokeWidth={STROKE}
						strokeLinecap="round"
						strokeDasharray={CIRCUMFERENCE}
						strokeDashoffset={CIRCUMFERENCE * (1 - fill)}
					/>
				)}
			</svg>
			<span
				className={cn(
					"relative leading-none font-semibold tracking-tight tabular-nums",
					why.dailyDemand === 0 && "text-faint",
				)}
				style={{
					fontSize: text.length <= 2 ? 12 : text.length === 3 ? 10.5 : 8.5,
				}}
			>
				{text}
			</span>
		</span>
	);
}

function Explanation({ why, onPo }: { why: ReorderWhy; onPo?: OnPo }) {
	const out = DEMAND_DAYS - why.inStockDays;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<p className="text-base leading-snug font-semibold">
						{why.dailyDemand === 0
							? `No sales in ${DEMAND_DAYS} days`
							: `${monthlyText(why.dailyDemand)} a month`}
					</p>
					<p className="text-xs text-muted-foreground">
						{[
							why.rank !== null &&
								`Top ${Math.max(1, Math.round((1 - why.rank) * 100))}%`,
							why.dailyDemand > 0 &&
								out > 0 &&
								`${plural(out, "sold-out day")} excluded`,
						]
							.filter(Boolean)
							.join(" · ")}
					</p>
				</div>
				<Ring why={why} />
			</div>
			<Verdict why={why} onPo={onPo} />
			<Bars why={why} />
			<Breakdown why={why} />
		</div>
	);
}

function Verdict({ why, onPo }: { why: ReorderWhy; onPo?: OnPo }) {
	const v = why.verdict;
	const suggested =
		v.kind === "order"
			? formatOrderQuantity({
					quantity: v.quantity,
					...(why.purchase ?? { unit: "EACH", packSize: 1, supplierCount: 1 }),
				})
			: null;
	const poText = onPo ? formatOrderQuantity(onPo) : null;
	return (
		<div
			className={cn(
				"rounded-lg px-3 py-2",
				v.kind === "order"
					? "bg-info-surface text-info-text"
					: v.kind === "awaiting" || v.kind === "undated"
						? "bg-warning-surface text-warning-text"
						: "bg-surface text-foreground",
			)}
		>
			<p className="font-semibold">
				{v.kind === "order"
					? why.purchase
						? // A count that isn't the supplier's says what it adds already.
							`Order ${suggested}${why.purchase.packSize > 1 && why.purchase.packSize === why.purchase.supplierCount ? ` (${formatCount(v.units)})` : ""}`
						: `Order ${formatCount(v.units)} (needs a supplier)`
					: v.kind === "later"
						? v.days === 0
							? "Reorder today"
							: `Reorder in ${plural(v.days, "day")}`
						: v.kind === "awaiting"
							? `Delivery in ${plural(v.days, "day")}, ${plural(v.gapDays, "day")} short`
							: v.kind === "undated"
								? `Awaiting ${formatCount(v.units)}, no delivery date`
								: "Nothing to order"}
			</p>
			{poText !== null && suggested !== poText && (
				<p className="text-xs opacity-80">
					{onPo?.purchaseOrderId ? `PO ${onPo.purchaseOrderId}` : "On PO"}:{" "}
					{poText}
				</p>
			)}
		</div>
	);
}

// Where the sales side of the reorder point ends: the wait plus the cushion.
const restockPoint = (why: ReorderWhy) =>
	why.aim.kind === "forecast" ? why.aim.restock + why.aim.safetyStock : 0;

type Segment = { key: string; units: number; color: string; striped?: boolean };

// Two bars on one scale: what reorder aims for, and what there is. The gap
// the order fills is plain to see, and the dashed line marks where ordering
// starts.
function Bars({ why }: { why: ReorderWhy }) {
	const v = why.verdict;
	const ordering = v.kind === "order";
	if (v.kind === "idle" && why.minStock === 0) return null;
	const min = (units: number): Segment[] => [
		{ key: "min", units, color: COLORS.min },
	];
	// Ordering: everything an order tops up to. Otherwise only the reorder
	// point matters, which min stock can raise past what sales call for.
	const aim: Segment[] =
		why.aim.kind === "min"
			? min(ordering ? why.aim.total : why.orderBelow)
			: !ordering && why.orderBelow > restockPoint(why)
				? min(why.orderBelow)
				: [
						{ key: "restock", units: why.aim.restock, color: COLORS.restock },
						{
							key: "safety",
							units: why.aim.safetyStock,
							color: COLORS.safety,
						},
						...(ordering
							? [{ key: "cover", units: why.aim.cover, color: COLORS.cover }]
							: []),
					];
	const incoming = why.incoming;
	const have: Segment[] = [
		{ key: "shelf", units: Math.max(why.onHand, 0), color: COLORS.shelf },
		{
			key: "coming",
			units: incoming.timely,
			color: COLORS.coming,
			striped: true,
		},
		{
			key: "late",
			units: incoming.aim - incoming.timely,
			color: COLORS.late,
			striped: true,
		},
		{
			key: "unmet",
			units: why.onOrder - incoming.aim,
			color: COLORS.unmet,
			striped: true,
		},
		...(ordering
			? [{ key: "order", units: v.units, color: COLORS.order, striped: true }]
			: []),
	];
	const total = (s: Segment[]) => s.reduce((sum, x) => sum + x.units, 0);
	const scale = Math.max(total(aim), total(have), why.orderBelow, 1);
	const pct = (n: number) => `${(n / scale) * 100}%`;
	return (
		<div className="relative flex flex-col gap-1.5 py-1">
			<BarRow label="Need" segments={aim} pct={pct} />
			<BarRow label="Have" segments={have} pct={pct} />
			{why.orderBelow > 0 && (
				<div
					className="pointer-events-none absolute inset-y-0 ml-11 border-l border-dashed border-foreground/50"
					style={{
						left: `calc((100% - 2.75rem) * ${why.orderBelow / scale})`,
					}}
				/>
			)}
		</div>
	);
}

function BarRow({
	label,
	segments,
	pct,
}: {
	label: string;
	segments: Segment[];
	pct: (n: number) => string;
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-9 shrink-0 text-[11px] text-muted-foreground">
				{label}
			</span>
			<div className="flex h-3 flex-1 overflow-hidden rounded-sm bg-surface">
				{segments.map(
					(s) =>
						s.units > 0 && (
							<div
								key={s.key}
								className="h-full border-r border-popover last:border-r-0"
								style={{
									width: pct(s.units),
									background: s.striped
										? `repeating-linear-gradient(45deg, ${s.color} 0 3px, color-mix(in oklab, ${s.color} 45%, transparent) 3px 6px)`
										: s.color,
								}}
							/>
						),
				)}
			</div>
		</div>
	);
}

// The arithmetic, one line per piece, each with the bar color it matches.
function Breakdown({ why }: { why: ReorderWhy }) {
	const v = why.verdict;
	const lead = why.leadTime;
	const leadNote = `${lead.days}-day lead time, ${
		lead.from === "measured"
			? "measured"
			: lead.from === "supplier"
				? "supplier's estimate"
				: "no supplier"
	}`;
	const cushion = `${why.abc ? `${why.abc} item` : "Unclassed"}, ${Math.round(why.serviceShare * 100)}% service`;
	const minSetsPoint =
		why.aim.kind === "min" || why.orderBelow > restockPoint(why);
	const have = afterArrival(why.onHand, why.incoming.aim);
	const notCounted = why.onOrder - why.incoming.aim;
	const minLabel = {
		stock: "Min stock",
		sets: "Enough to build each tool set",
		oversold: "Buy back what's oversold",
	}[why.minFrom];

	if (v.kind === "idle" && why.minStock === 0) return null;

	const rows: ReactNode[] = [];
	if (v.kind === "order") {
		if (why.aim.kind === "forecast") {
			rows.push(
				<Row
					key="restock"
					color={COLORS.restock}
					label="Sales during restock"
					note={leadNote}
					value={formatCount(why.aim.restock)}
				/>,
				<Row
					key="safety"
					color={COLORS.safety}
					label="Safety cushion"
					note={cushion}
					value={`+${formatCount(why.aim.safetyStock)}`}
				/>,
				<Row
					key="cover"
					color={COLORS.cover}
					label={`${why.coverDays} more days of sales`}
					value={`+${formatCount(why.aim.cover)}`}
				/>,
			);
		} else {
			rows.push(
				<Row
					key="min"
					color={COLORS.min}
					label={minLabel}
					note={`Sales alone: ${formatCount(why.aim.forecast)}`}
					value={formatCount(why.aim.total)}
				/>,
			);
		}
		const short = why.aim.total - have;
		rows.push(
			<Total key="aim" label="Target" value={formatCount(why.aim.total)} />,
			<Row
				key="shelf"
				color={COLORS.shelf}
				label="On shelf"
				note={
					why.onHand < 0
						? `${formatCount(-why.onHand)} oversold, written off on arrival`
						: undefined
				}
				value={minus(Math.max(why.onHand, 0))}
			/>,
			...(why.incoming.aim > 0
				? [
						<Row
							key="coming"
							color={COLORS.coming}
							striped
							label="Incoming"
							note={
								why.incoming.unknown > 0
									? `${formatCount(why.incoming.unknown)} without a delivery date`
									: undefined
							}
							value={minus(why.incoming.aim)}
						/>,
					]
				: []),
			...(notCounted > 0
				? [
						<Row
							key="unmet"
							color={COLORS.unmet}
							striped
							label="Not counted"
							note="due after the shelf runs out"
							value={formatCount(notCounted)}
						/>,
					]
				: []),
			<Total key="short" label="Short" value={formatCount(short)} />,
			...(why.untilLate > 0
				? [
						<Row
							key="late"
							color={COLORS.late}
							striped
							label="Bridge delivery gaps"
							value={formatCount(why.untilLate)}
						/>,
					]
				: []),
			<Row
				key="order"
				color={COLORS.order}
				striped
				label="Order"
				note={
					short <= 0 && why.onHand < 0
						? "Oversold with nothing on order"
						: !why.purchase || v.roundedUp === null
							? undefined
							: v.roundedUp === "minimum"
								? `Supplier minimum: ${formatOrderQuantity({ quantity: why.purchase.minimumQuantity, ...why.purchase })}`
								: `Rounded up to ${formatUnit(why.purchase)}`
				}
				value={formatCount(v.units)}
			/>,
		);
	} else {
		if (minSetsPoint) {
			rows.push(
				<Row
					key="min"
					color={COLORS.min}
					label={minLabel}
					note={
						why.aim.kind === "forecast"
							? `Sales alone: ${formatCount(restockPoint(why))}`
							: undefined
					}
					value={formatCount(why.orderBelow)}
				/>,
			);
		} else if (why.aim.kind === "forecast") {
			rows.push(
				<Row
					key="restock"
					color={COLORS.restock}
					label="Sales during restock"
					note={leadNote}
					value={formatCount(why.aim.restock)}
				/>,
				<Row
					key="safety"
					color={COLORS.safety}
					label="Safety cushion"
					note={cushion}
					value={`+${formatCount(why.aim.safetyStock)}`}
				/>,
			);
		}
		rows.push(
			<Total
				key="point"
				label="Reorder below"
				value={formatCount(why.orderBelow)}
			/>,
			<Row
				key="have"
				color={COLORS.shelf}
				label="Have"
				note={
					why.incoming.aim > 0
						? `${formatCount(Math.max(why.onHand, 0))} on shelf + ${formatCount(why.incoming.aim)} incoming`
						: undefined
				}
				value={formatCount(have)}
			/>,
		);
	}
	return <div className="flex flex-col gap-1.5 border-t pt-3">{rows}</div>;
}

function Row({
	color,
	striped = false,
	label,
	note,
	value,
}: {
	color: string;
	striped?: boolean;
	label: string;
	note?: string;
	value: string;
}) {
	return (
		<div className="flex items-start gap-2">
			<span
				className="mt-1 size-2.5 shrink-0 rounded-[3px]"
				style={{
					background: striped
						? `repeating-linear-gradient(45deg, ${color} 0 2px, color-mix(in oklab, ${color} 45%, transparent) 2px 4px)`
						: color,
				}}
				aria-hidden="true"
			/>
			<div className="min-w-0 flex-1">
				<p className="leading-snug">{label}</p>
				{note && (
					<p className="text-xs leading-snug text-muted-foreground">{note}</p>
				)}
			</div>
			<span className="font-medium tabular-nums">{value}</span>
		</div>
	);
}

function Total({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center gap-2 border-t border-dashed pt-1.5 font-semibold">
			<span className="w-2.5 shrink-0" />
			<span className="flex-1">{label}</span>
			<span className="tabular-nums">{value}</span>
		</div>
	);
}
