import type { StockRange } from "#/inventory/stock-range";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";

const SIZE = 34;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

// Where on hand sits from min (0) to max (1), clamped.
export function rangeFill(onHand: number, range: StockRange) {
	const share = (onHand - range.min) / (range.max - range.min);
	return Math.min(Math.max(share, 0), 1);
}

// Orange at min, through yellow, to green at max. Red is kept for oversold.
const fillColor = (fill: number) => `hsl(${30 + fill * 110} 75% 42%)`;

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
					stroke="#e3e3e3"
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
					"relative text-xs font-semibold tabular-nums",
					oversold && "text-critical-text",
				)}
			>
				{Math.abs(onHand) >= 1000 ? compact.format(onHand) : onHand}
			</span>
		</span>
	);
}
