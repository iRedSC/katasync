import { describe, expect, test } from "vitest";
import {
	comparePriority,
	coverOf,
	dailyProfitOf,
	daysOut,
	earnings,
	type PriorityInput,
	priorityOf,
	priorityRanks,
	setDailyOf,
	steadinessOf,
	WAIT_DAYS,
} from "./priority";

const open90 = Array.from({ length: 90 }, () => true);
// One order a week of `profit`, every week of the window.
const weekly = (profit: number) =>
	Array.from({ length: 13 }, (_, w) => ({ day: w * 7, profit }));

const base: PriorityInput = {
	orders: weekly(70),
	open: open90,
	sets: [],
	onHand: 0,
	dailyDemand: 1,
	incoming: [],
	leadTimeDays: 14,
	needsOrder: true,
	soldYear: 50,
	unitCost: 50,
};
const unproven = (onHand: number, unitCost = 50): PriorityInput => ({
	...base,
	orders: [],
	soldYear: 0,
	dailyDemand: 0,
	onHand,
	unitCost,
	needsOrder: false,
});

describe("dailyProfitOf", () => {
	test("counts orders, not units, at the typical order's profit", () => {
		// Four orders; one is a bulk buy worth 50 times the others.
		const orders = [
			{ day: 0, profit: 10 },
			{ day: 20, profit: 10 },
			{ day: 40, profit: 12 },
			{ day: 60, profit: 500 },
		];
		// 4 orders over 40 open days at the lower median's $10.
		expect(dailyProfitOf(orders, 40)).toBe(1);
	});

	test("a loss-making product earns nothing", () => {
		expect(dailyProfitOf([{ day: 0, profit: -5 }], 14)).toBe(0);
	});
});

describe("steadinessOf", () => {
	test("is the share of weeks it could sell in that it did", () => {
		const open = open90.map((_, d) => d < 28); // four weeks in stock
		expect(steadinessOf([{ day: 1, profit: 1 }], open)).toBe(0.25);
		expect(steadinessOf(weekly(1), open)).toBe(1);
	});
});

describe("earnings", () => {
	test("a slow seller with too few orders in 90 days reads the whole year", () => {
		// Two sales, both before the 90 day window.
		const e = earnings({
			orders: [
				{ day: -200, profit: 365 },
				{ day: -100, profit: 365 },
			],
			open: open90,
			sets: [],
		});
		// 2 orders a year at $365: $2 a day before steadiness.
		expect(e.own).toBeGreaterThan(1);
		expect(e.own).toBeLessThan(2);
	});
});

describe("setDailyOf", () => {
	test("takes half of each proven set, capped at its best set whole", () => {
		const sets = [
			{ setId: 1, orders: 5, daily: 10 },
			{ setId: 2, orders: 5, daily: 10 },
			{ setId: 3, orders: 5, daily: 10 },
			// Sold once: not proven demand.
			{ setId: 4, orders: 1, daily: 1000 },
		];
		expect(setDailyOf(sets)).toBe(10);
		expect(setDailyOf(sets.slice(0, 1))).toBe(5);
	});
});

describe("daysOut and coverOf", () => {
	test("count only the days inside the window", () => {
		// Empty from day 5; window 14 to 21.
		expect(daysOut(5, 1, [], 14, 21)).toBe(7);
		expect(daysOut(17, 1, [], 14, 21)).toBe(4);
		expect(daysOut(30, 1, [], 14, 21)).toBe(0);
		expect(coverOf(17, 1, [], 14)).toBe(17);
		expect(coverOf(5, 0, [], 14)).toBeNull();
	});

	test("a PO landing in time refills the shelf", () => {
		expect(daysOut(0, 1, [{ units: 100, inDays: 16 }], 14, 21)).toBe(2);
		expect(coverOf(2, 1, [{ units: 10, inDays: 1 }], 14)).toBe(12);
	});

	test("back-ordered units land when a new order would, so they don't make a duplicate urgent", () => {
		expect(daysOut(0, 1, [{ units: 100, inDays: null }], 14, 21)).toBe(0);
		expect(daysOut(0, 1, [{ units: 100, inDays: -3 }], 14, 21)).toBe(0);
		// Before then, nothing has come.
		expect(daysOut(0, 1, [{ units: 100, inDays: null }], 0, 14, 14)).toBe(14);
	});
});

describe("priorityOf tones", () => {
	test("red when it runs out before a PO sent today lands", () => {
		expect(priorityOf({ ...base, onHand: 5 }).tone).toBe("red");
	});

	test("orange when it lasts until the PO lands but not the week after", () => {
		const p = priorityOf({ ...base, onHand: 17 });
		expect(p).toMatchObject({ tone: "orange", daysOut: 4 });
		expect(p.atRisk).toBeCloseTo(4 * p.own);
	});

	test("yellow when reorder wants some but nothing is lost, green when covered", () => {
		expect(priorityOf({ ...base, onHand: 40 }).tone).toBe("yellow");
		expect(priorityOf({ ...base, onHand: 40, needsOrder: false }).tone).toBe(
			"green",
		);
	});

	test("zero stock is red even unproven; unproven with stock is yellow", () => {
		expect(priorityOf(unproven(0)).tone).toBe("red");
		expect(priorityOf(unproven(3)).tone).toBe("yellow");
	});

	test("zero stock is red even with a PO landing in time", () => {
		const p = priorityOf({
			...base,
			incoming: [{ units: 50, inDays: 3 }],
		});
		expect(p).toMatchObject({ tone: "red", atRisk: 0 });
	});
});

describe("comparePriority", () => {
	const order = (list: [string, PriorityInput][]) => {
		const ranks = priorityRanks(
			list.map(([, p], id) => ({ id, p: priorityOf(p) })),
			(x) => x.id,
			(x) => x.p,
		);
		return [...list.keys()]
			.sort((x, y) => (ranks.get(x) ?? 0) - (ranks.get(y) ?? 0))
			.map((i) => list[i][0]);
	};
	// A big seller: $70 an order, weekly, one unit a day.
	const seller = (onHand: number): PriorityInput => ({ ...base, onHand });
	// A slow one: one $20 sale in the year.
	const slow = (onHand: number): PriorityInput => ({
		...base,
		orders: [{ day: -100, profit: 20 }],
		soldYear: 1,
		dailyDemand: 1 / 365,
		onHand,
		needsOrder: false,
	});

	test("your order: selling low or out first, dead stock last", () => {
		expect(
			order([
				["high stock, no sales", unproven(500)],
				["high stock, low sales", slow(200)],
				["low stock, no sales", unproven(1)],
				["no stock, no sales", unproven(0)],
				["no stock, high sales", seller(0)],
			]),
		).toEqual([
			"no stock, high sales",
			"no stock, no sales",
			"low stock, no sales",
			"high stock, low sales",
			"high stock, no sales",
		]);
	});

	test("a high seller with more than a month spare sinks below a small one at zero", () => {
		const small = { ...slow(0), orders: weekly(5), dailyDemand: 0.2 };
		expect(
			order([
				["big, 60 days on hand", seller(60)],
				["small, out", small],
			]),
		).toEqual(["small, out", "big, 60 days on hand"]);
	});

	test("a high seller a little short of a month still beats a small one at zero", () => {
		const small = { ...slow(0), orders: [{ day: 10, profit: 5 }] };
		expect(
			order([
				["small, out", small],
				["big, 20 days on hand", seller(20)],
			]),
		).toEqual(["big, 20 days on hand", "small, out"]);
	});

	test("the less stock a seller has, the sooner", () => {
		expect(
			order([
				["30 on hand", seller(30)],
				["3 on hand", seller(3)],
				["18 on hand", seller(18)],
			]),
		).toEqual(["3 on hand", "18 on hand", "30 on hand"]);
	});

	test("no cost doesn't sink a product: 1 on hand beats 555", () => {
		expect(
			order([
				["555, cheap", { ...unproven(555), unitCost: 0.7 }],
				["1, no cost", { ...unproven(1), unitCost: null }],
			]),
		).toEqual(["1, no cost", "555, cheap"]);
	});

	test("an expensive product that never sold can't pass a seller running low", () => {
		const low = {
			...slow(1),
			orders: weekly(10),
			dailyDemand: 0.1,
			soldYear: 13,
		};
		expect(
			order([
				["unsold, $4,000, none", { ...unproven(0), unitCost: 4000 }],
				["$10 a week, 1 left", low],
			]),
		).toEqual(["$10 a week, 1 left", "unsold, $4,000, none"]);
	});

	test("not counted goes last", () => {
		expect(comparePriority(null, priorityOf(base))).toBeGreaterThan(0);
	});

	test("the week waited is WAIT_DAYS", () => {
		expect(priorityOf(base).daysOut).toBe(WAIT_DAYS);
	});
});
