import { useRef, useState } from "react";
import { shake } from "#/components/shake";
import { cn } from "#/lib/utils";
import {
	boardStatuses,
	type MoveTarget,
	refuseMove,
	statusNames,
} from "#/repairs/status";
import { daysIn } from "./board";
import type { Detail } from "./repair-data";

// Where the repair is, as the board's columns in a row: tap one to move it
// there. One it can't go to shakes and says why. Cancel sits apart, at the
// end, and restores once cancelled.

const steps = [...boardStatuses, "picked_up"] as const;

export function StatusBar({
	d,
	onMove,
}: {
	d: Detail;
	onMove: (to: MoveTarget) => void;
}) {
	const r = d.repair;
	const state = {
		status: r.status,
		bench: r.kind === "bench",
		hasDraft: r.draftOrderId !== null,
		paid: r.orderId !== null,
	};
	const [refused, setRefused] = useState<string | null>(null);
	const bar = useRef<HTMLDivElement>(null);

	function go(to: MoveTarget) {
		if (to === r.status) return;
		const why = refuseMove(state, to);
		if (why) {
			shake(bar.current);
			setRefused(why);
			setTimeout(() => setRefused(null), 2500);
			return;
		}
		onMove(to);
	}

	const cancelled = r.status === "cancelled";
	return (
		<div className="flex flex-wrap items-center gap-3">
			<div
				ref={bar}
				className={cn(
					"flex overflow-hidden rounded-lg bg-card shadow-card",
					cancelled && "opacity-50",
				)}
			>
				{/* A bench job has no pickup: it's done when listed, from its page. */}
				{(r.kind === "bench" ? boardStatuses : steps).map((s) => (
					<button
						key={s}
						type="button"
						aria-pressed={r.status === s}
						onClick={() => go(s)}
						className={cn(
							"h-9 px-4 font-semibold transition-colors",
							r.status === s
								? s === "picked_up"
									? "bg-success-fill text-success-text"
									: "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:bg-subtle hover:text-foreground",
						)}
					>
						{statusNames[s]}
					</button>
				))}
				{r.status === "refurbished" && (
					<span className="flex h-9 items-center bg-success-fill px-4 font-semibold text-success-text">
						{statusNames.refurbished}
					</span>
				)}
			</div>
			<span
				className={cn(
					"text-sm",
					refused ? "font-medium text-critical-text" : "text-muted-foreground",
				)}
			>
				{refused ??
					(cancelled
						? "Cancelled"
						: daysIn(r.statusChangedAt) === "Today"
							? "Since today"
							: `For ${daysIn(r.statusChangedAt)}`)}
			</span>
			{!r.orderId && r.status !== "refurbished" && (
				<button
					type="button"
					onClick={() => go(cancelled ? "received" : "cancelled")}
					className="ml-auto text-sm text-muted-foreground hover:text-critical-text"
				>
					{cancelled ? "Restore to the board" : "Cancel repair"}
				</button>
			)}
		</div>
	);
}
