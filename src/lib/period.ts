// A stretch of the shop's calendar to filter by: a named range that moves
// with the clock ("last month"), or days picked on a calendar, either end
// of which can be left open ("since Oct 1"). Days are the shop's, in Eastern
// time, and weeks start on Saturday, as profit's ranges do (orders/profit.ts
// resolves the named ones in SQL; a test holds the two together).
//
// As a word, the way chips and the URL carry it:
//
//   today  last_month  ...        a named range
//   2026-10-01..2026-10-15        days, both ends included
//   2026-10-01..   ..2026-10-15   open at one end
//   ..                            all time

import { SHOP_TIME_ZONE } from "./format";

export const RANGES = {
	today: "Today",
	yesterday: "Yesterday",
	this_week: "This week",
	last_week: "Last week",
	this_month: "This month",
	last_month: "Last month",
	last_30_days: "Last 30 days",
	last_90_days: "Last 90 days",
	this_year: "This year",
} as const;
export type RangeKey = keyof typeof RANGES;

export const isRangeKey = (v: unknown): v is RangeKey =>
	typeof v === "string" && Object.hasOwn(RANGES, v);

// A shop calendar day, "2026-10-21". Only made by the functions here, so a
// Day is always a real date.
export type Day = string & { readonly __day: unique symbol };

export type Period =
	| { kind: "range"; key: RangeKey }
	| { kind: "days"; from: Day | null; to: Day | null };

export const ALL_TIME: Period = { kind: "days", from: null, to: null };

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TIME_ZONE });

// The shop day an instant falls on.
export const dayOf = (at: Date | string) => dayKey.format(new Date(at)) as Day;

export const today = (now = new Date()) => dayOf(now);

// "2026-10-21" as a Day, or null when it isn't a real date.
export function parseDay(text: string): Day | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
	const t = Date.parse(`${text}T00:00:00Z`);
	if (Number.isNaN(t)) return null;
	// Date.parse rolls Feb 30 into March; a real date survives the round trip.
	return new Date(t).toISOString().slice(0, 10) === text ? (text as Day) : null;
}

// Calendar arithmetic on whole days, in UTC so no clock change shifts them.
const ms = (d: Day) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (t: number) => new Date(t).toISOString().slice(0, 10) as Day;
export const addDays = (d: Day, n: number) => fromMs(ms(d) + n * DAY_MS);
export const dayFromParts = (year: number, month: number, date: number) =>
	fromMs(Date.UTC(year, month, date));
export const partsOf = (d: Day) => {
	const t = new Date(ms(d));
	return {
		year: t.getUTCFullYear(),
		month: t.getUTCMonth(),
		date: t.getUTCDate(),
		weekday: t.getUTCDay(),
	};
};

// The first and last day a period covers, as of `on`. Null is open.
export function daysOf(
	p: Period,
	on: Day,
): { from: Day | null; to: Day | null } {
	if (p.kind === "days") return { from: p.from, to: p.to };
	const { year, month, weekday } = partsOf(on);
	// Back to Saturday: Saturday is 6, so it goes back none.
	const saturday = addDays(on, -((weekday + 1) % 7));
	switch (p.key) {
		case "today":
			return { from: on, to: on };
		case "yesterday":
			return { from: addDays(on, -1), to: addDays(on, -1) };
		case "this_week":
			return { from: saturday, to: on };
		case "last_week":
			return { from: addDays(saturday, -7), to: addDays(saturday, -1) };
		case "this_month":
			return { from: dayFromParts(year, month, 1), to: on };
		case "last_month":
			return {
				from: dayFromParts(year, month - 1, 1),
				to: dayFromParts(year, month, 0),
			};
		case "last_30_days":
			return { from: addDays(on, -29), to: on };
		case "last_90_days":
			return { from: addDays(on, -89), to: on };
		case "this_year":
			return { from: dayFromParts(year, 0, 1), to: on };
	}
}

export function within(day: Day, span: { from: Day | null; to: Day | null }) {
	return (
		(span.from === null || day >= span.from) &&
		(span.to === null || day <= span.to)
	);
}

export function spellPeriod(p: Period) {
	return p.kind === "range" ? p.key : `${p.from ?? ""}..${p.to ?? ""}`;
}

// The word back as a period, or null when it isn't one. Days picked the
// wrong way round are put right.
export function parsePeriod(text: string): Period | null {
	if (isRangeKey(text)) return { kind: "range", key: text };
	const m = /^(.*)\.\.(.*)$/.exec(text);
	if (!m) return null;
	const from = m[1] === "" ? null : parseDay(m[1]);
	const to = m[2] === "" ? null : parseDay(m[2]);
	// A side that was typed must be a real day, not quietly left open.
	if ((m[1] !== "" && !from) || (m[2] !== "" && !to)) return null;
	return from && to && from > to
		? { kind: "days", from: to, to: from }
		: { kind: "days", from, to };
}

export const isAllTime = (p: Period) =>
	p.kind === "days" && p.from === null && p.to === null;

const monthDay = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});
const monthDayYear = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

// "Oct 1", with the year only when it isn't this one.
export function formatDayShort(d: Day, on: Day = today()) {
	const date = new Date(ms(d));
	return d.slice(0, 4) === on.slice(0, 4)
		? monthDay.format(date)
		: monthDayYear.format(date);
}

// "Last month", "Oct 1 – 15", "Since Oct 1", "Until Oct 15", "All time".
export function describePeriod(p: Period, on: Day = today()) {
	if (p.kind === "range") return RANGES[p.key];
	const { from, to } = p;
	if (!from && !to) return "All time";
	if (!to) return `Since ${formatDayShort(from as Day, on)}`;
	if (!from) return `Until ${formatDayShort(to, on)}`;
	if (from === to) return formatDayShort(from, on);
	const sameMonth = from.slice(0, 7) === to.slice(0, 7);
	return sameMonth && from.slice(0, 4) === on.slice(0, 4)
		? `${formatDayShort(from, on)} – ${partsOf(to).date}`
		: `${formatDayShort(from, on)} – ${formatDayShort(to, on)}`;
}
