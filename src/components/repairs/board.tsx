import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock, Package } from "lucide-react";
import { Fragment, type PointerEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProductImage } from "#/components/product";
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

// The corkboard: a column per stage, each a queue worked from the top, and
// the last week's pickups and listed refurbs at the end. Cards are picked up
// and dropped between others, in their column or another; the arrow on
// each moves it one column on (last), for anyone not dragging.

const columns = [...boardStatuses, "picked_up"] as const;

export const stateOf = (c: RepairCard) => ({
	status: c.status,
	bench: c.kind === "bench",
	hasDraft: c.draftOrderName !== null,
	paid: c.orderName !== null,
});

// The column a card shows in: Done holds both ways of being done.
const columnOf = (c: RepairCard): MoveTarget =>
	c.status === "refurbished" ? "picked_up" : c.status;

// Where a card would go: above `before` (or last, null) in `to`.
export type Place = { to: MoveTarget; before: number | null };

const inQueue = (list: RepairCard[]) =>
	list.sort((a, b) => a.position - b.position || a.id - b.id);

// The place a card takes, as the server works it out (src/repairs/queue.ts),
// so it lands there at once.
export function positionAt(
	cards: RepairCard[],
	card: RepairCard,
	{ to, before }: Place,
) {
	const list = inQueue(
		cards.filter(
			(c) =>
				c.id !== card.id && columnOf(c) === columnOf({ ...card, status: to }),
		),
	);
	const at = before === null ? -1 : list.findIndex((c) => c.id === before);
	if (at === -1) return (list.at(-1)?.position ?? 0) + 1;
	const below = list[at].position;
	return ((at === 0 ? below - 1 : list[at - 1].position) + below) / 2;
}

// The card after it in its column, which undoing a move puts it back above.
export function nextInColumn(cards: RepairCard[], card: RepairCard) {
	const list = inQueue(cards.filter((c) => columnOf(c) === columnOf(card)));
	return list[list.findIndex((c) => c.id === card.id) + 1]?.id ?? null;
}

// Whether dropping it there leaves it where it is.
function stays(list: RepairCard[], c: RepairCard, before: number | null) {
	const at = list.findIndex((x) => x.id === c.id);
	return at !== -1 && (list[at + 1]?.id ?? null) === before;
}

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
	// To another column, or (to its own status) to another place in its own.
	onMove: (card: RepairCard, place: Place) => void;
}) {
	const [refused, setRefused] = useState<{
		to: MoveTarget;
		why: string;
	} | null>(null);
	const columnEls = useRef(new Map<MoveTarget, HTMLElement>());
	const listOf = (status: (typeof columns)[number]) =>
		inQueue(cards.filter((c) => columnOf(c) === status));
	const { lifted, pickUp } = useCardDrag<RepairCard>(
		(c) => String(c.id),
		(card, spot) => {
			const column = columns.find((s) => s === spot.column);
			if (!column) return;
			const before = spot.before === null ? null : Number(spot.before);
			if (column !== columnOf(card)) move(card, { to: column, before });
			// A listed refurb is done with for good, its place too.
			else if (
				card.status !== "refurbished" &&
				!stays(listOf(column), card, before)
			)
				onMove(card, { to: card.status, before });
		},
	);
	const over = lifted?.over;
	// The line where the carried card would land, unless that's where it is.
	const landing = (status: (typeof columns)[number], list: RepairCard[]) =>
		lifted &&
		over?.column === status &&
		!stays(list, lifted.item, over.before === null ? null : Number(over.before))
			? over.before
			: undefined;

	// A move that can't happen shakes the column it was aimed at, and says
	// why in a few words.
	function move(card: RepairCard, place: Place) {
		const why = refuseMove(stateOf(card), place.to);
		if (why) {
			shake(columnEls.current.get(place.to) ?? null);
			setRefused({ to: place.to, why });
			setTimeout(() => setRefused(null), 2500);
			return;
		}
		onMove(card, place);
	}

	return (
		<div className="grid min-h-[60vh] grid-flow-col auto-cols-[minmax(11.5rem,1fr)] gap-3 overflow-x-auto pb-2">
			{columns.map((status) => {
				const list = listOf(status);
				const line = landing(status, list);
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
							over?.column === status &&
								lifted &&
								columnOf(lifted.item) !== status &&
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
							<Fragment key={c.id}>
								{line === String(c.id) && <Landing />}
								<Card
									card={c}
									fresh={c.id === fresh}
									left={lifted?.item.id === c.id}
									onPickUp={(e) => pickUp(e, c)}
									onNext={nextArrow(c, status, move)}
								/>
							</Fragment>
						))}
						{line === null && <Landing />}
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

const Landing = () => (
	<div className="-my-1 h-0.5 rounded-full bg-info-border animate-in fade-in" />
);

const nextOf = (s: MoveTarget): MoveTarget | null =>
	columns[columns.indexOf(s as (typeof columns)[number]) + 1] ?? null;

// The arrow to the next column, where there's one it can go to: a bench
// job leaves Ready by being listed, from its page.
function nextArrow(
	c: RepairCard,
	status: MoveTarget,
	move: (c: RepairCard, place: Place) => void,
) {
	const next = nextOf(status);
	if (!next || (c.kind === "bench" && next === "picked_up")) return null;
	return () => move(c, { to: next, before: null });
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
			data-card={lifted ? undefined : c.id}
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
							(c.returnOrderName
								? `Return ${c.returnOrderName}`
								: "Not from a return")}
					</span>
				</div>
			) : (
				<div className="mt-1.5 truncate font-semibold">{c.customerName}</div>
			)}
			{c.tools.map((t) => (
				<div key={t.id} className="mt-0.5">
					<div className="flex items-center gap-2">
						{t.imageUrl && (
							<ProductImage src={t.imageUrl} className="size-7 shrink-0" />
						)}
						<span className="truncate">{t.tool}</span>
					</div>
					{t.problem && (
						<div
							className={cn(
								"text-xs text-muted-foreground",
								// Several tools: a line each, so the card stays short.
								c.tools.length > 1 ? "line-clamp-1" : "line-clamp-2",
							)}
						>
							{t.problem}
						</div>
					)}
				</div>
			))}
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
