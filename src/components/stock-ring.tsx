import type { StockRange } from "#/inventory/stock-range";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";

// The number sits in a 28px hole; the ring grows outward from it.
const HOLE = 28;
const STROKE = 5;
const SIZE = HOLE + 2 * STROKE;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// 1.5K, 12K, 120K: never more than four characters plus a minus sign.
const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumSignificantDigits: 2,
});

// Smaller type for longer numbers, so they stay inside the hole.
const fontSize = (text: string) =>
	text.length <= 2
		? 12
		: text.length === 3
			? 10.5
			: text.length === 4
				? 8.5
				: 7.5;

// Where on hand sits from min (0) to max (1), clamped.
export function rangeFill(onHand: number, range: StockRange) {
	const share = (onHand - range.min) / (range.max - range.min);
	return Math.min(Math.max(share, 0), 1);
}

// Orange at min, through yellow, to green at max. Lighter in the middle,
// since oklch yellow at the ends' lightness is olive. Red is kept for oversold.
const fillColor = (fill: number) =>
	`oklch(${0.7 + 0.12 * Math.sin(Math.PI * fill)} 0.17 ${55 + fill * 90})`;

// On hand as a number in a ring filled from min to max: empty at or under
// min, full at or over max. Oversold stock is a full red ring.
export function StockRing({
	onHand,
	range,
}: {
	onHand: number;
	range: StockRange & { own: boolean };
}) {
	const oversold = onHand < 0;
	const fill = oversold ? 1 : rangeFill(onHand, range);
	const text =
		Math.abs(onHand) >= 1000 ? compact.format(onHand) : String(onHand);
	return (
		<span
			className="relative inline-flex shrink-0 items-center justify-center"
			style={{ width: SIZE, height: SIZE }}
			title={`${formatCount(onHand)} on hand. Keep ${formatCount(range.min)} to ${formatCount(range.max)}${range.own ? "" : " (default)"}`}
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
						stroke={oversold ? "var(--critical-icon)" : fillColor(fill)}
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
					oversold && "text-critical-text",
				)}
				style={{ fontSize: fontSize(text) }}
			>
				{text}
			</span>
		</span>
	);
}
