// Which of a list of products to buy first, and whether any of them needs
// buying at all. Reorder decides how many; this decides the order. Pure: the
// loader is ./profit.ts.
//
// Two answers, kept apart. `tone` is absolute: red loses profit before a PO
// sent today could land, or sits at zero; orange runs out in the week after;
// yellow is below where reorder wants it, or unproven; green is covered.
// comparePriority is relative: it orders any list, so each list ranks
// P1, P2, ... however many products it holds, and never ties a list at zero.

// How long a product waits if it isn't ordered today: until the next order.
export const WAIT_DAYS = 7;

// A tool set counts toward a part only once it sold this many times in the
// window, so one odd set sale doesn't lift every part in it.
export const MIN_SET_ORDERS = 2;

// A part claims this share of each set's profit: running out stops the set,
// but buyers often take another set or the parts on their own.
export const SET_SHARE = 0.5;

const DAY_MS = 86_400_000;

// One order's take of a product: its profit, and the day it was placed on,
// counted from the 90 day demand window's first (older orders are negative,
// back to a year).
export type OrderTake = { day: number; profit: number };

// Sales from 90 days set a product's rate once it has any there. None, and
// the year's are used: the catalog sells slowly, and a tool that sells four
// times a year is still worth keeping.
export const MIN_RECENT_ORDERS = 1;
export const YEAR_DAYS = 365;
// How far before the demand window's first day the year reaches.
const YEAR_BEFORE = YEAR_DAYS - 90;

// What a day of a product earns, from its own orders over the days it was
// in stock. Orders, not units: four boxes of sponges in one order is one
// sale. Each order counts at the lower median order's profit, so one bulk
// buy doesn't read as steady demand.
export function dailyProfitOf(orders: OrderTake[], openDays: number) {
	if (orders.length === 0 || openDays <= 0) return 0;
	const sorted = orders.map((o) => o.profit).sort((a, b) => a - b);
	const typical = Math.max(0, sorted[Math.floor((sorted.length - 1) / 2)]);
	return (orders.length / openDays) * typical;
}

// Share of the window's weeks it could sell in that it did, 0 to 1. A week
// counts when any day of it was open (in stock, or sold anyway).
export function steadinessOf(orders: OrderTake[], open: boolean[]) {
	const weeks = new Set<number>();
	open.forEach((o, day) => {
		if (o) weeks.add(Math.floor(day / 7));
	});
	if (weeks.size === 0) return 0;
	const sold = new Set(orders.map((o) => Math.floor(o.day / 7)));
	return [...sold].filter((w) => weeks.has(w)).length / weeks.size;
}

// Sporadic sellers count for as little as half.
const steadyWeight = (steadiness: number) => 0.5 + 0.5 * steadiness;

// A set's day of profit, if it sold enough to count.
export type SetProfit = { setId: number; orders: number; daily: number };

// What a part's sets add to a day of it: SET_SHARE of each set that sold
// MIN_SET_ORDERS times, never more than its best set earns whole.
export function setDailyOf(sets: SetProfit[]) {
	const counted = sets.filter((s) => s.orders >= MIN_SET_ORDERS);
	const sum = counted.reduce((n, s) => n + SET_SHARE * s.daily, 0);
	return Math.min(sum, Math.max(0, ...counted.map((s) => s.daily)));
}

// Units on order, with when they land in days from now. Null is unknown:
// back-ordered, or a promised date already past.
export type Incoming = { units: number; inDays: number | null };

// Days in [from, to) the shelf sits empty, selling `daily` a day from
// `onHand`, with `incoming` landing. Unknown arrivals are counted as landing
// at `unknownAt` (by default `from`), when an order sent today would:
// ordering again wouldn't bring anything sooner, so they never make a
// duplicate urgent.
export function daysOut(
	onHand: number,
	daily: number,
	incoming: Incoming[],
	from: number,
	to: number,
	unknownAt = from,
) {
	if (daily <= 0 || to <= from) return 0;
	const events = incoming
		.filter((a) => a.units > 0)
		.map((a) => ({
			at: a.inDays === null || a.inDays < 0 ? unknownAt : a.inDays,
			units: a.units,
		}))
		.filter((a) => a.at < to)
		.sort((a, b) => a.at - b.at);
	let stock = Math.max(onHand, 0);
	let t = 0;
	let out = 0;
	for (const e of [...events, { at: to, units: 0 }]) {
		const end = Math.max(e.at, t);
		const empty = t + stock / daily;
		if (empty < end) {
			out += Math.max(0, Math.min(end, to) - Math.max(empty, from));
			stock = 0;
		} else stock -= (end - t) * daily;
		t = end;
		stock += e.units;
	}
	return out;
}

export const incomingOf = (
	arrivals: { units: number; arrivesAt: number | null }[],
	now: number,
): Incoming[] =>
	arrivals.map((a) => ({
		units: a.units,
		inDays: a.arrivesAt === null ? null : (a.arrivesAt - now) / DAY_MS,
	}));

export type Tone = "red" | "orange" | "yellow" | "green";

// A product's priority, with every piece it came from.
export type Priority = {
	tone: Tone;
	// Sold in the last year, itself or in a tool set that did. Unproven ones
	// rank by stock and what they cost, since nothing says what they earn.
	proven: boolean;
	// Profit lost if it waits WAIT_DAYS: daysOut × (own + sets) per day.
	atRisk: number;
	daysOut: number;
	// A day's profit from its own orders, after steadiness.
	own: number;
	// A day's profit from the tool sets it's part of.
	sets: number;
	// Share of weeks it sold in, 0 to 1.
	steadiness: number;
	// Days the shelf and POs landing in time last at its rate; null when it
	// doesn't sell, so never runs out.
	coverDays: number | null;
	onHand: number;
	leadTimeDays: number;
	// Units sold in the last year: breaks ties between sellers whose profit
	// can't be told apart, such as parts that sell inside sets.
	soldYear: number;
	// Per unit, what an unproven product is ranked by. Null without one.
	unitCost: number | null;
};

export type PriorityInput = {
	orders: OrderTake[];
	open: boolean[];
	sets: SetProfit[];
	onHand: number;
	// Units a day, sets' parts included: as reorder forecasts, or the year's
	// when the last 90 days sold nothing.
	dailyDemand: number;
	incoming: Incoming[];
	leadTimeDays: number;
	// Reorder wants some today (src/purchasing/reorder/quantity.ts).
	needsOrder: boolean;
	// Units sold in the last year, sets' parts included, even without a cost
	// to value them.
	soldYear: number;
	unitCost: number | null;
};

// A day's profit, own and from sets: from the last 90 days' in-stock days
// when it sold in them, else from the whole year.
export function earnings(p: Pick<PriorityInput, "orders" | "open" | "sets">) {
	const recent = p.orders.filter((o) => o.day >= 0);
	if (recent.length >= MIN_RECENT_ORDERS || p.orders.length === 0) {
		const openDays = Math.max(p.open.filter(Boolean).length, 14);
		const steadiness = steadinessOf(recent, p.open);
		return {
			own: dailyProfitOf(recent, openDays) * steadyWeight(steadiness),
			sets: setDailyOf(p.sets),
			steadiness,
		};
	}
	const year = p.orders.map((o) => ({ ...o, day: o.day + YEAR_BEFORE }));
	const steadiness = steadinessOf(
		year,
		Array.from({ length: YEAR_DAYS }, () => true),
	);
	return {
		own: dailyProfitOf(year, YEAR_DAYS) * steadyWeight(steadiness),
		sets: setDailyOf(p.sets),
		steadiness,
	};
}

// Days until the shelf runs dry selling `daily`, with what lands in time.
// Unknown arrivals land at `unknownAt`. Null when it never sells.
export function coverOf(
	onHand: number,
	daily: number,
	incoming: Incoming[],
	unknownAt: number,
) {
	if (daily <= 0) return null;
	const events = incoming
		.filter((a) => a.units > 0)
		.map((a) => ({
			at: a.inDays === null || a.inDays < 0 ? unknownAt : a.inDays,
			units: a.units,
		}))
		.sort((a, b) => a.at - b.at);
	let stock = Math.max(onHand, 0);
	let t = 0;
	for (const e of events) {
		const empty = t + stock / daily;
		if (empty < e.at) return empty;
		stock -= (e.at - t) * daily;
		t = e.at;
		stock += e.units;
	}
	return t + stock / daily;
}

export function priorityOf(p: PriorityInput): Priority {
	const { own, sets, steadiness } = earnings(p);
	const proven = p.orders.length > 0 || sets > 0 || p.soldYear > 0;
	const lead = p.leadTimeDays;
	const before = daysOut(p.onHand, p.dailyDemand, p.incoming, 0, lead, lead);
	const out = daysOut(
		p.onHand,
		p.dailyDemand,
		p.incoming,
		lead,
		lead + WAIT_DAYS,
	);
	const tone: Tone =
		p.onHand <= 0 || (proven && before > 0)
			? "red"
			: proven && out > 0
				? "orange"
				: !proven || p.needsOrder
					? "yellow"
					: "green";
	return {
		tone,
		proven,
		atRisk: out * (own + sets),
		daysOut: out,
		own,
		sets,
		steadiness,
		coverDays: coverOf(p.onHand, p.dailyDemand, p.incoming, lead),
		onHand: p.onHand,
		leadTimeDays: lead,
		soldYear: p.soldYear,
		unitCost: p.unitCost,
	};
}

// The order is one scale, what a day of it earns weighed by how soon it's
// needed, so the color never decides it. A seller out or running out before
// a PO could land counts its whole day; every spare day of stock past that
// fades it, so a big seller with a month's stock spare sinks below a small
// one at zero. Products that haven't sold in a year count a deliberately
// small guess, halved for each one on hand: none on hand sits above sellers
// with stock to spare, and UNPROVEN_DEAD or more on hand goes below
// everything that sells.

// Spare days of stock that fade a seller to about a third.
export const SPARE_FADE_DAYS = 10;
// From this many on hand, a product with no sales is dead stock: last.
export const UNPROVEN_DEAD = 3;
// What one is guessed to earn when nothing says: half its cost a sale, at
// least this cost, one sale a year.
const GUESS_FLOOR_COST = 10;
const GUESS_MARGIN = 0.5;
// An unsold product's guess counts at most this cost, so an expensive one
// that never sold can't pass for a seller running low.
const UNPROVEN_CAP_COST = 365;
const guessDaily = (unitCost: number | null, perYear: number) =>
	(Math.max(unitCost ?? 0, GUESS_FLOOR_COST) * GUESS_MARGIN * perYear) /
	YEAR_DAYS;

// What a day of it is worth for ranking: what it earns, or for sales without
// a cost (or only inside sets that sold too seldom to count), a guess from
// the units.
function dailyValue(p: Priority) {
	const earned = p.own + p.sets;
	if (!p.proven)
		return guessDaily(Math.min(p.unitCost ?? 0, UNPROVEN_CAP_COST), 1);
	return earned > 0 ? earned : guessDaily(p.unitCost, p.soldYear);
}

// How much of its day counts now: all of it while it runs out before a PO
// could land, fading with each spare day past that.
function urgency(p: Priority) {
	if (!p.proven) return 0.5 ** Math.max(p.onHand, 0);
	if (p.coverDays === null) return 0;
	const spare = Math.max(0, p.coverDays - p.leadTimeDays);
	return Math.exp(-spare / SPARE_FADE_DAYS);
}

const isDead = (p: Priority) => !p.proven && p.onHand >= UNPROVEN_DEAD;

export const rankWeight = (p: Priority) => dailyValue(p) * urgency(p);

// Orders any list most urgent first: by weight, then units sold in the
// year, then fewer on hand. Dead stock goes after everything else, the less
// of it first, and null (not counted) after that.
export function comparePriority(a: Priority | null, b: Priority | null) {
	if (a === null || b === null)
		return (a === null ? 1 : 0) - (b === null ? 1 : 0);
	if (isDead(a) || isDead(b))
		return (
			Number(isDead(a)) - Number(isDead(b)) ||
			(isDead(a) ? a.onHand - b.onHand : 0)
		);
	return (
		rankWeight(b) - rankWeight(a) ||
		b.soldYear - a.soldYear ||
		a.onHand - b.onHand
	);
}

// Each product's place in `list`, 1 first.
export function priorityRanks<T>(
	list: T[],
	idOf: (t: T) => number,
	priorityOf: (t: T) => Priority | null,
): Map<number, number> {
	const sorted = [...list].sort((a, b) =>
		comparePriority(priorityOf(a), priorityOf(b)),
	);
	return new Map(sorted.map((t, i) => [idOf(t), i + 1]));
}
