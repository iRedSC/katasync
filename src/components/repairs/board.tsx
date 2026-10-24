import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock, Package } from "lucide-react";
import { type PointerEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shake } from "#/components/shake";
import { formatPhone } from "#/lib/format";
import { cn } from "#/lib/utils";
import { formatMinutes } from "#/repairs/labor";
import type { RepairCard } from "#/repairs/read";
import {
	boardStatuses,
	type MoveTarget,
	refuseMove,
	statusNames,
} from "#/repairs/status";
import { PersonChip } from "./person-chip";
import { useCardDrag } from "./use-card-drag";

// The corkboard: a column per stage, oldest at the top, and the last week's
// pickups and listed refurbs at the end. Cards are picked up and dropped on another column;
// the arrow on each moves it one column on, for anyone not dragging.

const columns = [...boardStatuses, "picked_up"] as const;

export const stateOf = (c: RepairCard) => ({
	status: c.status,
	bench: c.kind === "bench",
	hasDraft: c.draftOrderName !== null,
	paid: c.orderName !== null,
});

export function daysIn(since: Date | string) {
	const days = Math.floor(
		(Date.now() - new Date(since).getTime()) / 86_400_000,
	);
	return days < 1 ? "Today" : `${days}d`;
}

export function Board({
	cards,
	fresh,
	onMove,
}: {
	cards: RepairCard[];
	// Just made, so it stands out as it lands.
	fresh: number | null;
	onMove: (card: RepairCard, to: MoveTarget) => void;
}) {
	const [refused, setRefused] = useState<{
		to: MoveTarget;
		why: string;
	} | null>(null);
	const columnEls = useRef(new Map<MoveTarget, HTMLElement>());
	const { lifted, pickUp } = useCardDrag<RepairCard>((card, column) => {
		const to = columns.find((s) => s === column);
		if (to && to !== card.status) move(card, to);
	});
	const over = lifted?.over;

	// A move that can't happen shakes the column it was aimed at, and says
	// why in a few words.
	function move(card: RepairCard, to: MoveTarget) {
		const why = refuseMove(stateOf(card), to);
		if (why) {
			shake(columnEls.current.get(to) ?? null);
			setRefused({ to, why });
			setTimeout(() => setRefused(null), 2500);
			return;
		}
		onMove(card, to);
	}

	return (
		<div className="grid min-h-[60vh] grid-flow-col auto-cols-[minmax(11.5rem,1fr)] gap-3 overflow-x-auto pb-2">
			{columns.map((status) => {
				const list = cards.filter(
					(c) =>
						c.status === status ||
						(status === "picked_up" && c.status === "refurbished"),
				);
				return (
					<section
						key={status}
						data-column={status}
						ref={(el) => {
							if (el) columnEls.current.set(status, el);
						}}
						// Rings inset, so the board's scrolling edge doesn't clip them.
						className={cn(
							"flex flex-col gap-2 rounded-xl bg-surface p-2 transition-colors",
							over === status &&
								over !== lifted?.item.status &&
								"bg-info-surface ring-2 ring-inset ring-info-border",
							refused?.to === status &&
								"bg-critical-surface ring-2 ring-inset ring-critical-border",
							status === "picked_up" && "opacity-80",
						)}
					>
						<header className="flex items-center justify-between px-1 pt-1">
							<h2 className="text-sm font-semibold">
								{status === "picked_up" ? "Done" : statusNames[status]}
							</h2>
							<span className="text-xs text-muted-foreground tabular-nums">
								{refused?.to === status ? (
									<span className="font-medium text-critical-text">
										{refused.why}
									</span>
								) : (
									list.length
								)}
							</span>
						</header>
						{list.map((c) => (
							<Card
								key={c.id}
								card={c}
								fresh={c.id === fresh}
								left={lifted?.item.id === c.id}
								onPickUp={(e) => pickUp(e, c)}
								onNext={nextArrow(c, status, move)}
							/>
						))}
					</section>
				);
			})}
			{lifted &&
				createPortal(
					<div
						className="pointer-events-none fixed z-50"
						style={{
							left: lifted.x - lifted.grabX,
							top: lifted.y - lifted.grabY,
							width: lifted.width,
						}}
					>
						<Card card={lifted.item} fresh={false} lifted onNext={null} />
					</div>,
					document.body,
				)}
		</div>
	);
}

const nextOf = (s: MoveTarget): MoveTarget | null =>
	columns[columns.indexOf(s as (typeof columns)[number]) + 1] ?? null;

// The arrow to the next column, where there's one it can go to: a bench
// job leaves Ready by being listed, from its page.
function nextArrow(
	c: RepairCard,
	status: MoveTarget,
	move: (c: RepairCard, to: MoveTarget) => void,
) {
	const next = nextOf(status);
	if (!next || (c.kind === "bench" && next === "picked_up")) return null;
	return () => move(c, next);
}

function Card({
	card: c,
	fresh,
	left = false,
	lifted = false,
	onPickUp,
	onNext,
}: {
	card: RepairCard;
	fresh: boolean;
	// Its place on the board while it's carried.
	left?: boolean;
	// The card being carried, following the pointer.
	lifted?: boolean;
	onPickUp?: (e: PointerEvent<HTMLElement>) => void;
	onNext: (() => void) | null;
}) {
	const age = daysIn(c.statusChangedAt);
	// Sitting a week waiting for pickup, or for a part.
	const stale =
		(c.status === "ready" || c.status === "waiting_parts") &&
		Date.now() - new Date(c.statusChangedAt).getTime() > 7 * 86_400_000;
	return (
		<article
			onPointerDown={onPickUp}
			className={cn(
				"group relative rounded-lg bg-card p-3 shadow-card transition-shadow select-none [-webkit-touch-callout:none] hover:shadow-md",
				fresh && "animate-in fade-in slide-in-from-top-2 ring-2 ring-primary",
				left && "opacity-30",
				lifted &&
					"rotate-2 scale-[1.03] cursor-grabbing shadow-xl animate-in zoom-in-95 duration-100",
			)}
		>
			{!lifted && (
				<Link
					to="/repairs/$id"
					params={{ id: String(c.id) }}
					draggable={false}
					className="absolute inset-0 rounded-lg"
					aria-label={`Open R${c.id}`}
				/>
			)}
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<span className="font-mono font-semibold text-foreground">R{c.id}</span>
				<span
					className={cn(
						"flex items-center gap-1",
						stale && "font-medium text-warning-text",
					)}
				>
					<Clock className="size-3" />
					{age}
				</span>
				{c.technician && c.technicianId && (
					<span className="ml-auto">
						<PersonChip id={c.technicianId} name={c.technician} />
					</span>
				)}
			</div>
			{c.kind === "bench" ? (
				<div className="mt-1.5 flex items-center gap-2">
					<span className="rounded-md bg-foreground px-1.5 text-xs font-semibold text-background">
						Refurb
					</span>
					<span className="truncate text-xs text-muted-foreground">
						{c.refurbSku ??
							(c.returnOrderName ? `Return ${c.returnOrderName}` : "Bought in")}
					</span>
				</div>
			) : (
				<div className="mt-1.5 truncate font-semibold">{c.customerName}</div>
			)}
			<div className="truncate">{c.tool}</div>
			{c.problem && (
				<div className="line-clamp-2 text-xs text-muted-foreground">
					{c.problem}
				</div>
			)}
			<div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
				{c.status === "ready" && c.customerPhone && (
					<a
						href={`tel:${c.customerPhone}`}
						className="relative font-medium text-link"
					>
						{formatPhone(c.customerPhone)}
					</a>
				)}
				{c.laborMinutes > 0 && <span>{formatMinutes(c.laborMinutes)}</span>}
				{c.parts > 0 && (
					<span className="flex items-center gap-1">
						<Package className="size-3" />
						{c.parts}
					</span>
				)}
				{c.orderName && (
					<span className="text-success-text">Paid {c.orderName}</span>
				)}
				{onNext && (
					<button
						type="button"
						onClick={onNext}
						aria-label="Move to the next column"
						className="relative ml-auto rounded-md p-1 opacity-60 hover:bg-surface-strong hover:opacity-100 group-hover:opacity-100"
					>
						<ArrowRight className="size-4" />
					</button>
				)}
			</div>
		</article>
	);
}
