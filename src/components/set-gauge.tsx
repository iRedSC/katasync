import { cn } from "#/lib/utils";
import type { SetCoverage } from "#/purchasing/sets";

// Sized like StockRing, so the two line up in the After PO column.
const HOLE = 28;
const STROKE = 5;
const SIZE = HOLE + 2 * STROKE;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// Space between segments, so one-part slices read as separate.
const GAP = 2.5;

// In ring order from the top, clockwise.
const SEGMENTS = [
	{ kind: "here", color: "var(--success-icon)" },
	{ kind: "covered", color: "var(--info-icon)" },
	{ kind: "short", color: "var(--critical-icon)" },
	{ kind: "skipped", color: "var(--surface-strong)" },
] as const;

export function coverageText(c: SetCoverage) {
	const total = c.here + c.covered + c.short + c.skipped;
	return [
		`${c.here} of ${total} ${total === 1 ? "part" : "parts"} ordered on this PO`,
		c.covered > 0 && `${c.covered} on other suppliers' POs`,
		c.skipped > 0 && `${c.skipped} skipped`,
		c.short > 0 && `${c.short} short`,
	]
		.filter(Boolean)
		.join(", ");
}

// A tool set's parts as one ring, a slice per part: green on this PO, blue on
// other suppliers' POs, red not ordered for every set, gray skipped. The
// middle says how many of the parts this PO orders.
export function SetGauge({ coverage: c }: { coverage: SetCoverage }) {
	const total = c.here + c.covered + c.short + c.skipped;
	const slice = CIRCUMFERENCE / Math.max(total, 1);
	let offset = 0;
	const text = `${c.here}/${total}`;
	return (
		<span
			className="relative inline-flex shrink-0 items-center justify-center"
			style={{ width: SIZE, height: SIZE }}
			title={coverageText(c)}
		>
			<svg
				width={SIZE}
				height={SIZE}
				className="absolute inset-0 -rotate-90"
				aria-hidden="true"
			>
				{SEGMENTS.map(({ kind, color }) => {
					const length = c[kind] * slice;
					const start = offset;
					offset += length;
					if (length === 0) return null;
					// Each part is its own slice, with a gap after it.
					return Array.from({ length: c[kind] }, (_, i) => (
						<circle
							// biome-ignore lint/suspicious/noArrayIndexKey: slices never reorder
							key={`${kind}${i}`}
							cx={SIZE / 2}
							cy={SIZE / 2}
							r={RADIUS}
							fill="none"
							stroke={color}
							strokeWidth={STROKE}
							strokeDasharray={`${total === 1 ? slice : slice - GAP} ${CIRCUMFERENCE}`}
							strokeDashoffset={-(start + i * slice)}
						/>
					));
				})}
			</svg>
			<span
				className={cn(
					"relative leading-none font-semibold tracking-tight tabular-nums",
					c.short > 0 && "text-critical-text",
				)}
				style={{ fontSize: text.length <= 3 ? 10.5 : 8.5 }}
			>
				{text}
			</span>
		</span>
	);
}
