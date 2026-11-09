import { HoverCard } from "radix-ui";
import type { CSSProperties } from "react";
import { formatCount, formatMoney } from "#/lib/format";
import {
	type Priority,
	type Tone,
	WAIT_DAYS,
} from "#/purchasing/reorder/priority";

// Whether it needs buying at all, whatever its rank: red loses profit before
// a PO sent today lands or sits at zero, orange runs out the week after,
// yellow is below target or unproven, green is covered.
const mix = (a: string, b: string) => `color-mix(in oklab, ${a}, ${b})`;
const swatch = (tone: string) => ({
	surface: `var(--${tone}-surface)`,
	text: `var(--${tone}-text)`,
	border: `var(--${tone}-border)`,
});
const red = swatch("critical");
const yellow = swatch("warning");
const TONES: Record<Tone, { surface: string; text: string; border: string }> = {
	red,
	orange: {
		surface: mix(red.surface, yellow.surface),
		text: mix(red.text, yellow.text),
		border: mix(red.border, yellow.border),
	},
	yellow,
	green: swatch("success"),
};

const perDay = (n: number) => `${formatMoney(n)}/day`;
const days = (n: number) =>
	n >= 1000 ? "1,000+" : Number.isInteger(n) ? String(n) : n.toFixed(1);

// A product's place in the list it's shown in, P1 first, colored by whether
// it needs buying. Hovering or focusing it shows what put it there.
export function PriorityRank({
	priority,
	rank,
}: {
	priority: Priority | null;
	// Null when it isn't ranked in this list, e.g. another supplier's.
	rank: number | null;
}) {
	if (!priority)
		return <span className="block text-center text-muted-foreground">—</span>;
	const p = priority;
	const label = rank === null ? "·" : `P${formatCount(rank)}`;
	return (
		<HoverCard.Root openDelay={150} closeDelay={100}>
			<HoverCard.Trigger asChild>
				<button
					type="button"
					aria-label={`${rank === null ? "Unranked" : `Priority ${rank}`}, ${p.tone}. Show why`}
					style={
						{
							background: TONES[p.tone].surface,
							color: TONES[p.tone].text,
							"--tw-ring-color": TONES[p.tone].border,
						} as CSSProperties
					}
					className="mx-auto flex h-7 min-w-10 cursor-help items-center justify-center rounded-full px-2 font-semibold tabular-nums ring-1 outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
					// The row behind opens the product; this only explains.
					onClick={(e) => e.stopPropagation()}
				>
					{label}
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
					{p.proven ? <Proven p={p} /> : <Unproven p={p} />}
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

function Proven({ p }: { p: Priority }) {
	return (
		<>
			{p.atRisk > 0 ? (
				<>
					<p className="text-2xl font-semibold tabular-nums">
						{formatMoney(p.atRisk)}
					</p>
					<p className="text-muted-foreground">
						lost if it waits {WAIT_DAYS} days
					</p>
				</>
			) : (
				<p className="font-semibold">
					{p.onHand <= 0
						? "Out of stock"
						: p.coverDays === null
							? "Covered"
							: `Covered for ${days(Math.floor(p.coverDays))} days`}
				</p>
			)}
			<dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
				{p.atRisk > 0 && (
					<>
						<dt className="text-muted-foreground">Days sold out</dt>
						<dd className="text-right">
							{days(p.daysOut)} of {WAIT_DAYS}
						</dd>
					</>
				)}
				<dt className="text-muted-foreground">Own sales</dt>
				<dd className="text-right">{perDay(p.own)}</dd>
				<dt className="text-muted-foreground">Tool sets</dt>
				<dd className="text-right">{perDay(p.sets)}</dd>
				<dt className="text-muted-foreground">Weeks it sold</dt>
				<dd className="text-right">{Math.round(p.steadiness * 100)}%</dd>
			</dl>
		</>
	);
}

// Nothing sold in a year: ranked by stock and cost, since nothing says what
// it earns.
function Unproven({ p }: { p: Priority }) {
	return (
		<>
			<p className="font-semibold">Unproven</p>
			<p className="text-muted-foreground">
				{p.onHand <= 0
					? "No sales in a year and none to sell. Stock it or cut it."
					: "No sales in a year."}
			</p>
			<dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
				<dt className="text-muted-foreground">On hand</dt>
				<dd className="text-right">{formatCount(p.onHand)}</dd>
				<dt className="text-muted-foreground">Cost each</dt>
				<dd className="text-right">{formatMoney(p.unitCost)}</dd>
			</dl>
		</>
	);
}
