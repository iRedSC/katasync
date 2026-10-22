import { Tip } from "#/components/ui/tooltip";
import { formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";

// Hours and minutes, "5h 20m" or "40m".
export function span(ms: number) {
	const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
	const h = Math.floor(minutes / 60);
	return h > 0 ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

// How long is left to answer, coloured as it runs out.
export function DueChip({ due, now }: { due: Date; now: number }) {
	const left = new Date(due).getTime() - now;
	return (
		<Tip content={`Due ${formatDateTime(due)}`}>
			<span
				className={cn(
					"inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-xs font-semibold tabular-nums",
					left < 0
						? "bg-critical-fill text-critical-text"
						: left < 6 * 3_600_000
							? "bg-warning-fill text-warning-text"
							: "bg-surface-strong text-muted-foreground",
				)}
			>
				{left < 0 ? `${span(left)} over` : `${span(left)} left`}
			</span>
		</Tip>
	);
}
