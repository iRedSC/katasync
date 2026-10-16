import { describe, expect, test } from "vitest";
import { forecastMax } from "./stock-range";
import {
	daysLeft,
	levelOf,
	nextStepOf,
	type StockInput,
	TRUST_DAYS,
	trustOf,
} from "./stock-state";

const now = new Date("2026-10-16T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function product(extra: Partial<StockInput> = {}): StockInput {
	return {
		kind: "simple",
		abc: "A",
		onHand: 20,
		available: 20,
		range: { min: 10, max: 40 },
		lastCountedAt: daysAgo(5),
		countRequested: false,
		hasSupplier: true,
		draft: null,
		reorder: null,
		...extra,
	};
}

const reorder = { quantity: 12, unit: "EACH", packSize: 1, supplierCount: 1 };

describe("trust", () => {
	test("a count inside the window vouches for the number", () => {
		expect(
			trustOf(product({ lastCountedAt: daysAgo(TRUST_DAYS) }), now),
		).toEqual({ kind: "counted", at: daysAgo(TRUST_DAYS) });
	});

	test("an old count or none at all needs a count", () => {
		for (const lastCountedAt of [daysAgo(TRUST_DAYS + 1), null])
			expect(trustOf(product({ lastCountedAt }), now)).toEqual({
				kind: "needs count",
				requested: false,
			});
	});

	test("tool sets go by their parts' counts like any product", () => {
		expect(
			trustOf(product({ kind: "bundle", lastCountedAt: null }), now),
		).toMatchObject({ kind: "needs count" });
	});
});

describe("level", () => {
	test("oversold beats everything", () => {
		expect(levelOf(product({ onHand: -2, available: 0 }))).toBe("oversold");
	});

	test("sold out beats below min", () => {
		expect(levelOf(product({ onHand: 3, available: 0 }))).toBe("sold out");
	});

	test("against the range", () => {
		expect(levelOf(product({ onHand: 9, available: 9 }))).toBe("below min");
		expect(levelOf(product({ onHand: 10, available: 10 }))).toBe("healthy");
		expect(levelOf(product({ onHand: 40, available: 40 }))).toBe("healthy");
		expect(levelOf(product({ onHand: 41, available: 41 }))).toBe("over max");
	});

	test("tool sets go by what can be built", () => {
		const set = product({ kind: "bundle", onHand: null });
		expect(levelOf({ ...set, available: 0 })).toBe("missing parts");
		expect(levelOf({ ...set, available: 2 })).toBe("healthy");
	});
});

describe("next step", () => {
	const step = (p: StockInput) => nextStepOf(p, trustOf(p, now));

	test("trusted stock that needs ordering gets ordered", () => {
		expect(step(product({ reorder }))).toEqual({ kind: "order", ...reorder });
	});

	test("untrusted stock gets counted before it's ordered", () => {
		expect(step(product({ reorder, lastCountedAt: null }))).toEqual({
			kind: "count",
		});
		expect(
			step(product({ reorder, lastCountedAt: null, countRequested: true })),
		).toEqual({ kind: "count requested" });
	});

	test("C and unclassed stock orders without waiting for a count", () => {
		for (const abc of ["C", null] as const)
			expect(step(product({ abc, reorder, lastCountedAt: null }))).toEqual({
				kind: "order",
				...reorder,
			});
	});

	test("a line already on a draft wins", () => {
		expect(
			step(
				product({
					reorder,
					lastCountedAt: null,
					draft: { purchaseOrderId: 1004 },
				}),
			),
		).toEqual({ kind: "on draft", purchaseOrderId: 1004 });
	});

	test("short stock with no supplier asks for one", () => {
		for (const [onHand, available] of [
			[2, 2],
			[0, 0],
			[-3, 0],
		])
			expect(step(product({ onHand, available, hasSupplier: false }))).toEqual({
				kind: "set supplier",
			});
	});

	test("healthy stock needs nothing; a set that can't be built orders", () => {
		expect(step(product())).toEqual({ kind: "none" });
		expect(
			step(product({ kind: "bundle", onHand: null, available: 0, reorder })),
		).toEqual({ kind: "order", ...reorder });
	});
});

test("days left at the sales rate", () => {
	expect(daysLeft(30, 2)).toBe(15);
	expect(daysLeft(5, 0)).toBeNull();
	expect(daysLeft(-3, 1)).toBe(0);
	expect(daysLeft(null, 1)).toBeNull();
});

describe("default max from the forecast", () => {
	const p = { leadTimeDays: 14, safetyStock: 0, coverDays: 30 };

	test("is what a reorder tops up to", () => {
		// 0.5 a day over 14 + 30 days.
		expect(forecastMax(1, { ...p, dailyDemand: 0.5 })).toBe(22);
	});

	test("is at least 5 when little sells, and always above min", () => {
		expect(forecastMax(1, { ...p, dailyDemand: 0 })).toBe(5);
		expect(forecastMax(1, { ...p, dailyDemand: 0.05 })).toBe(5);
		expect(forecastMax(8, { ...p, dailyDemand: 0 })).toBe(9);
	});
});
