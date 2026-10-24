import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock, Package } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { shake } from "#/components/shake";
import { formatPhone } from "#/lib/format";
import { cn } from "#/lib/utils";
import { formatMinutes } from "#/repairs/labor";
import type { RepairCard } from "#/repairs/read";
import {
	boardStatuses,
	type RepairStatus,
	refuseMove,
	statusNames,
} from "#/repairs/status";
import { PersonChip } from "./person-chip";

// The corkboard: a column per stage, oldest at the top, and the last week's
// pickups at the end. Cards drag between columns; the arrow on each moves
// it one column on, for a tablet or anyone not dragging.

const columns = [...boardStatuses, "picked_up"] as const;

export const stateOf = (c: RepairCard) => ({
	status: c.status,
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
	onMove: (card: RepairCard, to: RepairStatus) => void;
}) {
	const [over, setOver] = useState<RepairStatus | null>(null);
	const [refused, setRefused] = useState<{
		to: RepairStatus;
		why: string;
	} | null>(null);
	const dragging = useRef<RepairCard | null>(null);
	const columnEls = useRef(new Map<RepairStatus, HTMLElement>());

	function drop(e: DragEvent, to: RepairStatus) {
		e.preventDefault();
		setOver(null);
		const card = dragging.current;
		dragging.current = null;
		if (!card || card.status === to) return;
		move(card, to);
	}

	// A move that can't happen shakes the column it was aimed at, and says
	// why in a few words.
	function move(card: RepairCard, to: RepairStatus) {
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
				const list = cards.filter((c) => c.status === status);
				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: a drop target; each card's arrow moves it without dragging
					<section
						key={status}
						ref={(el) => {
							if (el) columnEls.current.set(status, el);
						}}
						onDragOver={(e) => {
							e.preventDefault();
							setOver(status);
						}}
						onDragLeave={() => setOver((o) => (o === status ? null : o))}
						onDrop={(e) => drop(e, status)}
						className={cn(
							"flex flex-col gap-2 rounded-xl bg-surface p-2 transition-colors",
							over === status && "bg-info-surface ring-2 ring-info-border",
							refused?.to === status &&
								"bg-critical-surface ring-2 ring-critical-border",
							status === "picked_up" && "opacity-80",
						)}
					>
						<header className="flex items-center justify-between px-1 pt-1">
							<h2 className="text-sm font-semibold">{statusNames[status]}</h2>
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
								onDragStart={() => {
									dragging.current = c;
								}}
								onNext={
									nextOf(status) && (() => move(c, nextOf(status) ?? status))
								}
							/>
						))}
					</section>
				);
			})}
		</div>
	);
}

const nextOf = (s: RepairStatus): RepairStatus | null =>
	columns[columns.indexOf(s as (typeof columns)[number]) + 1] ?? null;

function Card({
	card: c,
	fresh,
	onDragStart,
	onNext,
}: {
	card: RepairCard;
	fresh: boolean;
	onDragStart: () => void;
	onNext: (() => void) | null;
}) {
	const age = daysIn(c.statusChangedAt);
	// Sitting a week waiting for pickup, or for a part.
	const stale =
		(c.status === "ready" || c.status === "waiting_parts") &&
		Date.now() - new Date(c.statusChangedAt).getTime() > 7 * 86_400_000;
	return (
		<article
			draggable
			onDragStart={(e) => {
				e.dataTransfer.effectAllowed = "move";
				onDragStart();
			}}
			className={cn(
				"group relative rounded-lg bg-card p-3 shadow-card transition-shadow hover:shadow-md",
				fresh && "animate-in fade-in slide-in-from-top-2 ring-2 ring-primary",
			)}
		>
			<Link
				to="/repairs/$id"
				params={{ id: String(c.id) }}
				className="absolute inset-0 rounded-lg"
				aria-label={`Open R${c.id}`}
			/>
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
			<div className="mt-1.5 truncate font-semibold">{c.customerName}</div>
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
