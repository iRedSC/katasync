import { describe, expect, test } from "vitest";
import {
	dailyProfitOf,
	daysOut,
	type PriorityInput,
	priorityOf,
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
};

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

describe("daysOut", () => {
	test("counts only the days inside the window", () => {
		// Empty from day 5; window 14 to 21.
		expect(daysOut(5, 1, [], 14, 21)).toBe(7);
		// Lasts to day 17.
		expect(daysOut(17, 1, [], 14, 21)).toBe(4);
		expect(daysOut(30, 1, [], 14, 21)).toBe(0);
	});

	test("a PO landing inside the window refills the shelf", () => {
		expect(daysOut(0, 1, [{ units: 100, inDays: 16 }], 14, 21)).toBe(2);
	});

	test("back-ordered units land when a new order would, so they don't make a duplicate urgent", () => {
		expect(daysOut(0, 1, [{ units: 100, inDays: null }], 14, 21)).toBe(0);
		// Promised for a date already past: the same.
		expect(daysOut(0, 1, [{ units: 100, inDays: -3 }], 14, 21)).toBe(0);
	});
});

describe("priorityOf", () => {
	test("the best earner sold out for the whole week scores 100", () => {
		const p = priorityOf(base, 10);
		expect(p.daysOut).toBe(WAIT_DAYS);
		expect(p.own).toBeCloseTo(10.11);
		expect(p.score).toBe(100);
	});

	test("zero stock isn't urgent when a PO lands before the week", () => {
		const p = priorityOf({ ...base, incoming: [{ units: 50, inDays: 3 }] }, 10);
		expect(p).toMatchObject({ score: 0, atRisk: 0 });
	});

	test("a high-volume consumable with thin margins ranks below a profitable tool", () => {
		// 10 orders a week at $1 each, against one a week at $70.
		const sponge = priorityOf(
			{
				...base,
				orders: Array.from({ length: 130 }, (_, i) => ({
					day: i % 90,
					profit: 1,
				})),
				dailyDemand: 50,
			},
			10,
		);
		const tool = priorityOf(base, 10);
		expect(sponge.score).toBeLessThan(tool.score);
		expect(sponge.atRisk).toBeLessThan(tool.atRisk);
	});

	test("a one-off bulk buyer counts less than a steady seller of the same profit", () => {
		const bulk = priorityOf(
			{ ...base, orders: [{ day: 3, profit: 13 * 70 }] },
			10,
		);
		expect(bulk.atRisk).toBeLessThan(priorityOf(base, 10).atRisk * 0.6);
		expect(bulk.steadiness).toBeCloseTo(1 / 13);
	});

	test("a part that sells only in a proven set earns from the set", () => {
		const p = priorityOf(
			{ ...base, orders: [], sets: [{ setId: 9, orders: 10, daily: 20 }] },
			10,
		);
		expect(p).toMatchObject({ own: 0, sets: 10, score: 100 });
	});
});
