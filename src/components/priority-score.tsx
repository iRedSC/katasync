import { HoverCard } from "radix-ui";
import { formatMoney } from "#/lib/format";
import { type Priority, WAIT_DAYS } from "#/purchasing/reorder/priority";

// Heats up with the score, with no cutoff: 0 is muted, 100 full critical.
const tone = (score: number) => ({
	background: `color-mix(in oklab, var(--critical-surface) ${score}%, transparent)`,
	color: `color-mix(in oklab, var(--critical-text) ${score}%, var(--muted-foreground))`,
	"--tw-ring-color": `color-mix(in oklab, var(--critical-border) ${score}%, transparent)`,
});

const perDay = (n: number) => `${formatMoney(n)}/day`;
const days = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// A product's priority, 0 to 100, colored by how urgent it is. Hovering or
// focusing it shows the dollars it came from.
export function PriorityScore({ priority }: { priority: Priority | null }) {
	if (!priority)
		return <span className="block text-center text-muted-foreground">—</span>;
	const p = priority;
	return (
		<HoverCard.Root openDelay={150} closeDelay={100}>
			<HoverCard.Trigger asChild>
				<button
					type="button"
					aria-label={`Priority ${p.score}: waiting a week loses ${formatMoney(p.atRisk)}. Show why`}
					style={tone(p.score)}
					className="mx-auto flex h-7 w-10 cursor-help items-center justify-center rounded-full font-semibold tabular-nums ring-1 outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
					// The row behind opens the product; this only explains.
					onClick={(e) => e.stopPropagation()}
				>
					{p.score}
				</button>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side="left"
					align="center"
					sideOffset={8}
					collisionPadding={12}
					onClick={(e) => e.stopPropagation()}
					className="z-50 w-72 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-black/10"
				>
					<p className="text-2xl font-semibold tabular-nums">
						{formatMoney(p.atRisk)}
					</p>
					<p className="text-muted-foreground">
						lost if it waits {WAIT_DAYS} days
					</p>
					<dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
						<dt className="text-muted-foreground">Days sold out</dt>
						<dd className="text-right">
							{days(p.daysOut)} of {WAIT_DAYS}
						</dd>
						<dt className="text-muted-foreground">Own sales</dt>
						<dd className="text-right">{perDay(p.own)}</dd>
						<dt className="text-muted-foreground">Tool sets</dt>
						<dd className="text-right">{perDay(p.sets)}</dd>
						<dt className="text-muted-foreground">Weeks it sold</dt>
						<dd className="text-right">{Math.round(p.steadiness * 100)}%</dd>
					</dl>
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}
