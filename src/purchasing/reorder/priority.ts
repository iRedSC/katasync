// How much profit a product loses if its reorder waits. Reorder decides how
// many to buy; this decides which come first. Pure: the loader is
// ./profit.ts.
//
// The dollars are a week's delay: the days it would sit sold out between
// when a PO sent today lands and when one sent a week from now would,
// times what a day of it earns. A product whose shelf and open POs cover
// that week loses nothing by waiting, however low it looks. One already
// out, whose PO lands in time anyway, loses nothing either.

// How long a product waits if it isn't ordered today: until the next order.
export const WAIT_DAYS = 7;

// A tool set counts toward a part only once it sold this many times in the
// window, so one odd set sale doesn't lift every part in it.
export const MIN_SET_ORDERS = 2;

// A part claims this share of each set's profit: running out stops the set,
// but buyers often take another set or the parts on their own.
export const SET_SHARE = 0.5;

const DAY_MS = 86_400_000;

// One order's take of a product: its profit, and the window day it was
// placed on (0 is the window's first).
export type OrderTake = { day: number; profit: number };

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
// `onHand`, with `incoming` landing. Unknown arrivals are counted as
// landing at `from`, when an order sent today would: ordering again
// wouldn't bring anything sooner, so they never make a duplicate urgent.
export function daysOut(
	onHand: number,
	daily: number,
	incoming: Incoming[],
	from: number,
	to: number,
) {
	if (daily <= 0 || to <= from) return 0;
	const events = incoming
		.filter((a) => a.units > 0)
		.map((a) => ({
			at: a.inDays === null || a.inDays < 0 ? from : a.inDays,
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

// A product's priority, with every piece the score came from.
export type Priority = {
	// 0 to 100, log scaled: 100 is the best earner out the whole week.
	score: number;
	// Profit lost if it waits WAIT_DAYS: daysOut × (own + sets) per day.
	atRisk: number;
	daysOut: number;
	// A day's profit from its own orders, after steadiness.
	own: number;
	// A day's profit from the tool sets it's part of.
	sets: number;
	// Share of weeks it sold in, 0 to 1.
	steadiness: number;
};

export type PriorityInput = {
	orders: OrderTake[];
	open: boolean[];
	sets: SetProfit[];
	onHand: number;
	// Units a day, sets' parts included, as reorder forecasts.
	dailyDemand: number;
	incoming: Incoming[];
	leadTimeDays: number;
};

// A day's profit, own and from sets.
export function earnings(p: Pick<PriorityInput, "orders" | "open" | "sets">) {
	const openDays = Math.max(p.open.filter(Boolean).length, 14);
	const steadiness = steadinessOf(p.orders, p.open);
	return {
		own: dailyProfitOf(p.orders, openDays) * steadyWeight(steadiness),
		sets: setDailyOf(p.sets),
		steadiness,
	};
}

// `best` is the most a day of any product earns, which sets 100.
export function priorityOf(p: PriorityInput, best: number): Priority {
	const { own, sets, steadiness } = earnings(p);
	const out = daysOut(
		p.onHand,
		p.dailyDemand,
		p.incoming,
		p.leadTimeDays,
		p.leadTimeDays + WAIT_DAYS,
	);
	const atRisk = out * (own + sets);
	const top = best * WAIT_DAYS;
	const score =
		top <= 0
			? 0
			: Math.min(100, Math.round((100 * Math.log1p(atRisk)) / Math.log1p(top)));
	return {
		score,
		atRisk,
		daysOut: out,
		own,
		sets,
		steadiness,
	};
}
