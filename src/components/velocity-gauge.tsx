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
	sold: "oklch(0.62 0.15 255)",
	min: "oklch(0.7 0.12 75)",
	shelf: "var(--success-icon)",
	coming: "var(--info-icon)",
	order: "var(--primary)",
} as const;

// Sold out for at least this share of the cover days: its recent sales read
// low enough to flag on the ring.
const OUT_FLAG_SHARE = 0.25;

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
					aria-label={`${monthlyText(why.dailyDemand)} sold a month${soldOutLong(why) ? `, sold out ${plural(why.recent.outDays, "day")} lately` : ""}. Show why`}
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

// Sold out long enough over the cover days that ordering up to its sales
// buys too few.
const soldOutLong = (why: ReorderWhy) =>
	why.recent.outDays >= why.coverDays * OUT_FLAG_SHARE;

function Ring({ why }: { why: ReorderWhy }) {
	const fill = why.rank === null ? 0 : Math.max(why.rank, 0.04);
	const text = monthlyText(why.dailyDemand);
	return (
		<span
			className="relative inline-flex shrink-0 items-center justify-center"
			style={{ width: SIZE, height: SIZE }}
		>
			{soldOutLong(why) && (
				<span
					className="absolute -top-0.5 -right-0.5 z-10 size-2.5 rounded-full bg-warning-icon ring-2 ring-background"
					aria-hidden="true"
				/>
			)}
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

type Segment = { key: string; units: number; color: string; striped?: boolean };

// Two bars on one scale: what reorder tops up to, and what there is. The
// gap the order fills is plain to see.
function Bars({ why }: { why: ReorderWhy }) {
	const v = why.verdict;
	if (why.aim.total === 0 && why.onOrder === 0 && why.onHand <= 0) return null;
	const aim: Segment[] = [
		{
			key: why.aim.kind,
			units: why.aim.total,
			color: why.aim.kind === "min" ? COLORS.min : COLORS.sold,
		},
	];
	const have: Segment[] = [
		{ key: "shelf", units: Math.max(why.onHand, 0), color: COLORS.shelf },
		{ key: "coming", units: why.onOrder, color: COLORS.coming, striped: true },
		...(v.kind === "order"
			? [{ key: "order", units: v.units, color: COLORS.order, striped: true }]
			: []),
	];
	const total = (s: Segment[]) => s.reduce((sum, x) => sum + x.units, 0);
	const scale = Math.max(total(aim), total(have), 1);
	const pct = (n: number) => `${(n / scale) * 100}%`;
	return (
		<div className="flex flex-col gap-1.5 py-1">
			<BarRow label="Need" segments={aim} pct={pct} />
			<BarRow label="Have" segments={have} pct={pct} />
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

// The arithmetic, one line per piece, each with the bar color it matches:
// what sold (or the floor), less shelf and on order, is the order.
function Breakdown({ why }: { why: ReorderWhy }) {
	const v = why.verdict;
	if (v.kind === "idle" && why.aim.total === 0) return null;
	const sold = (
		<Row
			key="sold"
			color={COLORS.sold}
			label={`Sold last ${plural(why.coverDays, "day")}`}
			note={
				why.recent.outDays > 0
					? `Sold out ${plural(why.recent.outDays, "day")} of them`
					: undefined
			}
			warn={soldOutLong(why)}
			value={formatCount(why.recent.sold)}
		/>
	);
	const rows: ReactNode[] =
		why.aim.kind === "min"
			? [
					<Row
						key="min"
						color={COLORS.min}
						label={
							{
								stock: "Min stock",
								sets: "Enough to build each tool set",
								oversold: "Buy back what's oversold",
							}[why.minFrom]
						}
						note={`Sold last ${plural(why.coverDays, "day")}: ${formatCount(why.aim.sales)}`}
						value={formatCount(why.aim.total)}
					/>,
				]
			: [sold];
	const short = why.aim.total - afterArrival(why.onHand, why.onOrder);
	rows.push(
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
		...(why.onOrder > 0
			? [
					<Row
						key="coming"
						color={COLORS.coming}
						striped
						label="On order"
						value={minus(why.onOrder)}
					/>,
				]
			: []),
	);
	if (v.kind === "order")
		rows.push(
			<Total key="short" label="Short" value={formatCount(short)} />,
			<Row
				key="order"
				color={COLORS.order}
				striped
				label="Order"
				note={
					!why.purchase || v.roundedUp === null
						? undefined
						: v.roundedUp === "minimum"
							? `Supplier minimum: ${formatOrderQuantity({ quantity: why.purchase.minimumQuantity, ...why.purchase })}`
							: `Rounded up to ${formatUnit(why.purchase)}`
				}
				value={formatCount(v.units)}
			/>,
		);
	else
		rows.push(<Total key="spare" label="Spare" value={formatCount(-short)} />);
	return <div className="flex flex-col gap-1.5 border-t pt-3">{rows}</div>;
}

function Row({
	color,
	striped = false,
	label,
	note,
	warn = false,
	value,
}: {
	color: string;
	striped?: boolean;
	label: string;
	note?: string;
	// The note says the number reads wrong: shown in the ring's flag color.
	warn?: boolean;
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
					<p
						className={cn(
							"text-xs leading-snug",
							warn ? "text-warning-text" : "text-muted-foreground",
						)}
					>
						{note}
					</p>
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
