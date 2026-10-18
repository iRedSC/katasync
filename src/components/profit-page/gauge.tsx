import { formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";

// The profit gauge's scale squeezes as it grows, so every row shares it: the
// first $10 takes a real step, and $300 either way reaches the end. A sale past
// that stops at the edge with a mark.
const GAUGE_STEP = 10;
const GAUGE_END = 300;
// Where a profit sits from -1 (the left end) to 1 (the right).
const gauge = (profit: number) =>
	Math.sign(profit) *
	Math.min(
		1,
		Math.log1p(Math.abs(profit) / GAUGE_STEP) /
			Math.log1p(GAUGE_END / GAUGE_STEP),
	);

// Where a profit falls, at a glance: color fills from the zero line out to a
// pin, red for a loss and green for a gain, so its length is how much.
export function Gauge({ profit, unsure }: { profit: number; unsure: boolean }) {
	const at = 50 + gauge(profit) * 50;
	const loss = profit < 0;
	const past = Math.abs(profit) > GAUGE_END;
	return (
		<div
			role="img"
			aria-label={`${loss ? "Lost" : "Made"} ${formatMoney(Math.abs(profit))}`}
			// Without a cost the profit is too high, so the gauge is faded too.
			className={cn("relative h-4 w-28", unsure && "opacity-40")}
		>
			<div className="absolute inset-x-0 top-1.5 h-1 rounded-full bg-black/8" />
			<div
				className={cn(
					"absolute top-1.5 h-1",
					loss
						? "rounded-l-full bg-critical-icon"
						: "rounded-r-full bg-success-icon",
				)}
				style={{ left: `${Math.min(50, at)}%`, width: `${Math.abs(at - 50)}%` }}
			/>
			<div className="absolute inset-y-0.5 left-1/2 w-px bg-black/35" />
			<div
				className={cn(
					"absolute top-0.75 size-2.5 -translate-x-1/2 rounded-full border-2 bg-white shadow-sm",
					loss ? "border-critical-icon" : "border-success-icon",
				)}
				style={{ left: `${at}%` }}
			/>
			{past && (
				<span
					className={cn(
						"absolute -top-px text-[10px] font-bold",
						loss
							? "-left-2.5 text-critical-icon"
							: "-right-2.5 text-success-icon",
					)}
				>
					{loss ? "‹" : "›"}
				</span>
			)}
		</div>
	);
}
