import {
	ArrowLeftToLine,
	ArrowRightToLine,
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	type Day,
	dayFromParts,
	describePeriod,
	formatDayShort,
	parseDay,
	partsOf,
	today as todayOf,
} from "#/lib/period";
import { cn } from "#/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

// The app's one calendar. DayCalendar picks a day; RangeCalendar picks a
// span in two clicks, a first day then a last, and each month starts with
// an arrow that leaves the start open ("until Oct 15") and ends with one
// that leaves the end open ("since Oct 1"). Hovering shows what the next
// click would pick. Days outside min and max can't be clicked, so a date
// the server would refuse can't be picked.

type Span = { from: Day | null; to: Day | null };
type Bounds = { min?: Day | null; max?: Day | null };

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const monthName = new Intl.DateTimeFormat("en-US", {
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});

type Month = { year: number; month: number };
const monthOf = (d: Day): Month => {
	const p = partsOf(d);
	return { year: p.year, month: p.month };
};
const addMonths = (m: Month, n: number) =>
	monthOf(dayFromParts(m.year, m.month + n, 1));

// How one day looks: in the span, at its ends, or out of reach.
type Look = { inside: boolean; edge: boolean; disabled: boolean };

function MonthGrid({
	shown,
	look,
	onPick,
	onHover,
	onPrev,
	onNext,
	arrows,
}: {
	shown: Month;
	look: (d: Day) => Look;
	onPick: (d: Day) => void;
	onHover?: (d: Day) => void;
	onPrev?: () => void;
	onNext?: () => void;
	// The open-end arrows at the month's first and last weeks.
	arrows?: { before: ReactNode; after: ReactNode };
}) {
	const { year, month } = shown;
	const now = todayOf();
	const first = dayFromParts(year, month, 1);
	const length = partsOf(dayFromParts(year, month + 1, 0)).date;
	const cells: (Day | null)[] = [
		...Array.from({ length: partsOf(first).weekday }, () => null),
		...Array.from({ length }, (_, i) => dayFromParts(year, month, i + 1)),
	];
	while (cells.length % 7) cells.push(null);
	const weeks = Array.from({ length: cells.length / 7 }, (_, w) =>
		cells.slice(w * 7, w * 7 + 7),
	);

	const nav = (onClick: (() => void) | undefined, next: boolean) =>
		onClick ? (
			<button
				type="button"
				aria-label={next ? "Later month" : "Earlier month"}
				onClick={onClick}
				className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
			>
				{next ? (
					<ChevronRight className="size-4" />
				) : (
					<ChevronLeft className="size-4" />
				)}
			</button>
		) : (
			<span className="size-7" />
		);

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between">
				{nav(onPrev, false)}
				<span className="text-sm font-medium">
					{monthName.format(new Date(Date.UTC(year, month, 1)))}
				</span>
				{nav(onNext, true)}
			</div>
			<div
				className={cn(
					"grid gap-y-0.5 text-center text-sm",
					arrows
						? "grid-cols-[2rem_repeat(7,2rem)_2rem]"
						: "grid-cols-[repeat(7,2rem)]",
				)}
			>
				{arrows && <span />}
				{WEEKDAYS.map((d) => (
					<span key={d} className="text-xs leading-6 text-muted-foreground">
						{d}
					</span>
				))}
				{arrows && <span />}
				{weeks.map((week, w) => (
					<div key={week.find(Boolean)} className="contents">
						{arrows && (w === 0 ? arrows.before : <span />)}
						{week.map((d, i) => {
							if (d === null)
								// biome-ignore lint/suspicious/noArrayIndexKey: blank cells have nothing else
								return <span key={`blank-${i}`} />;
							const { inside, edge, disabled } = look(d);
							return (
								<button
									key={d}
									type="button"
									disabled={disabled}
									onClick={() => onPick(d)}
									onMouseEnter={() => onHover?.(d)}
									onFocus={() => onHover?.(d)}
									aria-pressed={edge}
									className={cn(
										"relative size-8 rounded-md tabular-nums transition-colors hover:bg-surface disabled:pointer-events-none disabled:opacity-30",
										d > now && "text-muted-foreground",
										inside && "rounded-none bg-surface-strong",
										edge &&
											"rounded-md bg-primary text-primary-foreground hover:bg-primary",
										d === now &&
											!edge &&
											"after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-link",
									)}
								>
									{partsOf(d).date}
								</button>
							);
						})}
						{arrows && (w === weeks.length - 1 ? arrows.after : <span />)}
					</div>
				))}
			</div>
		</div>
	);
}

const outside = (d: Day, b: Bounds) =>
	(!!b.min && d < b.min) || (!!b.max && d > b.max);

export function DayCalendar({
	value,
	onPick,
	min,
	max,
}: {
	value: Day | null;
	onPick: (d: Day) => void;
} & Bounds) {
	const [shown, setShown] = useState(() =>
		monthOf(value ?? max ?? todayOf()),
	);
	const reach = (n: number) => {
		const next = addMonths(shown, n);
		const edge = n < 0 ? dayFromParts(shown.year, shown.month, 0) : dayFromParts(next.year, next.month, 1);
		return outside(edge, { min, max }) ? undefined : () => setShown(next);
	};
	return (
		<div className="p-1">
			<MonthGrid
				shown={shown}
				look={(d) => ({
					inside: false,
					edge: d === value,
					disabled: outside(d, { min, max }),
				})}
				onPick={onPick}
				onPrev={reach(-1)}
				onNext={reach(1)}
			/>
		</div>
	);
}

// The first click: a day, or an open end.
type Anchor = Day | "before" | "after";

// The span two picks make, whichever order they came in.
function spanOf(a: Anchor, b: Anchor): Span {
	const day = (x: Anchor) => (x === "before" || x === "after" ? null : x);
	if (a === "before" || b === "before")
		return { from: null, to: a === "after" || b === "after" ? null : day(a) ?? day(b) };
	if (a === "after" || b === "after") return { from: day(a) ?? day(b), to: null };
	return a <= b ? { from: a, to: b } : { from: b, to: a };
}

const inSpan = (d: Day, s: Span) =>
	(s.from === null || d >= s.from) && (s.to === null || d <= s.to);

export function RangeCalendar({
	value,
	onPick,
	months = 2,
}: {
	value: Span | null;
	onPick: (span: Span) => void;
	months?: 1 | 2;
}) {
	const now = todayOf();
	// The last month shown: the end of what's picked, or this one.
	const [last, setLast] = useState(() =>
		monthOf(value?.to ?? value?.from ?? now),
	);
	const [anchor, setAnchor] = useState<Anchor | null>(null);
	const [hover, setHover] = useState<Anchor | null>(null);
	const preview = anchor ? spanOf(anchor, hover ?? anchor) : value;

	function pick(a: Anchor) {
		if (anchor === null) return setAnchor(a);
		setAnchor(null);
		onPick(spanOf(anchor, a));
	}

	const arrow = (side: "before" | "after") => {
		const Icon = side === "before" ? ArrowLeftToLine : ArrowRightToLine;
		const open =
			preview !== null &&
			(side === "before" ? preview.from === null : preview.to === null);
		return (
			<button
				type="button"
				aria-label={side === "before" ? "No start" : "No end"}
				aria-pressed={anchor === side}
				onClick={() => pick(side)}
				onMouseEnter={() => setHover(side)}
				className={cn(
					"inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground",
					open && "bg-surface-strong text-foreground",
					anchor === side && "bg-primary text-primary-foreground",
				)}
			>
				<Icon className="size-3.5" />
			</button>
		);
	};

	const shown = Array.from({ length: months }, (_, i) =>
		addMonths(last, i - (months - 1)),
	);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: leaving clears the hover preview
		<div className="flex flex-col gap-2 p-1" onMouseLeave={() => setHover(null)}>
			<div className="flex gap-4">
				{shown.map((m, i) => (
					<MonthGrid
						key={`${m.year}-${m.month}`}
						shown={m}
						look={(d) => ({
							inside: preview !== null && inSpan(d, preview),
							edge:
								anchor === d ||
								(preview !== null && (preview.from === d || preview.to === d)),
							disabled: false,
						})}
						onPick={pick}
						onHover={setHover}
						onPrev={i === 0 ? () => setLast((l) => addMonths(l, -1)) : undefined}
						onNext={
							i === shown.length - 1
								? () => setLast((l) => addMonths(l, 1))
								: undefined
						}
						arrows={{ before: arrow("before"), after: arrow("after") }}
					/>
				))}
			</div>
			<p className="h-4 px-1 text-xs text-muted-foreground tabular-nums">
				{preview && describePeriod({ kind: "days", ...preview }, now)}
			</p>
		</div>
	);
}

// A date field: the day as words, and the calendar on click. Values are
// YYYY-MM-DD, as date inputs and the server take them; "" is no date,
// which only a clearable field can have.
export function DateInput({
	value,
	onChange,
	min,
	max,
	clearable = false,
	disabled,
	invalid,
	className,
	...aria
}: {
	value: string;
	onChange: (day: string) => void;
	min?: string;
	max?: string;
	clearable?: boolean;
	disabled?: boolean;
	invalid?: boolean;
	className?: string;
	"aria-label"?: string;
}) {
	const [open, setOpen] = useState(false);
	const day = parseDay(value);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				disabled={disabled}
				className={cn(
					"inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-input bg-background px-2 text-left tabular-nums outline-none focus:border-ring disabled:opacity-50 data-[state=open]:border-ring",
					invalid && "border-critical-border ring-2 ring-critical-border/40",
					className,
				)}
				{...aria}
			>
				<CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
				<span className={cn("flex-1 truncate", !day && "text-muted-foreground")}>
					{day ? formatDayShort(day) : "None"}
				</span>
				{clearable && day && (
					// A span, since a button can't sit inside the trigger.
					// biome-ignore lint/a11y/useSemanticElements: nested in the trigger button
					<span
						role="button"
						tabIndex={-1}
						aria-label="Clear"
						onPointerDown={(e) => {
							e.preventDefault();
							e.stopPropagation();
							onChange("");
						}}
						className="rounded p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
					>
						<X className="size-3" />
					</span>
				)}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-auto">
				<DayCalendar
					value={day}
					min={min ? parseDay(min) : null}
					max={max ? parseDay(max) : null}
					onPick={(d) => {
						onChange(d);
						setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}
