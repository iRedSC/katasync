import { describe, expect, test } from "vitest";
import { explainReorder, reorderQuantity, velocityRanks } from "./reorder";

describe("explainReorder", () => {
	const base = {
		recentSold: 30,
		dailyDemand: 1,
		onHand: 0,
		onOrder: 0,
		coverDays: 30,
		minStock: 0,
		setFloor: 0,
		minimumQuantity: 1,
		packSize: 1,
	};
	const context = {
		inStockDays: 90,
		outDays: 0,
		rank: 0.5,
		purchase: {
			unit: "EACH",
			packSize: 1,
			supplierCount: 1,
			minimumQuantity: 1,
		},
		sets: { shelf: 0, sets: [] },
	};

	test("aims at what sold, and says how long it sat sold out", () => {
		const why = explainReorder(base, { ...context, outDays: 9 });
		expect(why.aim).toEqual({ kind: "sales", total: 30 });
		expect(why.recent).toEqual({ sold: 30, outDays: 9 });
	});

	test("orders what reorderQuantity orders, and says why it's rounded", () => {
		const input = { ...base, onHand: 5, onOrder: 3, packSize: 12 };
		const why = explainReorder(input, {
			...context,
			purchase: {
				unit: "CASE",
				packSize: 12,
				supplierCount: 12,
				minimumQuantity: 1,
			},
		});
		// Aim 30, have 8: short 22, so 2 cases of 12.
		expect(why.verdict).toEqual({
			kind: "order",
			quantity: reorderQuantity(input),
			units: 24,
			roundedUp: "pack",
		});
		expect(
			explainReorder({ ...base, minimumQuantity: 50 }, context).verdict,
		).toMatchObject({ quantity: 50, roundedUp: "minimum" });
	});

	test("waits, or does nothing, when stock covers what sold", () => {
		expect(explainReorder({ ...base, onHand: 36 }, context).verdict).toEqual({
			kind: "later",
			days: 6,
		});
		expect(
			explainReorder({ ...base, recentSold: 0, dailyDemand: 0 }, context)
				.verdict,
		).toEqual({ kind: "idle" });
	});

	test("says when its tool sets, not min stock, set the floor", () => {
		const why = explainReorder(
			{ ...base, minStock: 40, setFloor: 50 },
			context,
		);
		expect(why).toMatchObject({
			aim: { kind: "min", total: 50, sales: 30 },
			minStock: 50,
			minFrom: "sets",
		});
		expect(
			explainReorder({ ...base, minStock: 50, setFloor: 50 }, context),
		).toMatchObject({ minStock: 50, minFrom: "stock" });
	});
});

test("velocityRanks spreads selling products from 0 to 1, ties sharing", () => {
	const f = (dailyDemand: number) => ({
		dailyDemand,
		inStockDays: 90,
		days: [],
	});
	const ranks = velocityRanks(
		new Map([
			[1, f(0)],
			[2, f(1)],
			[3, f(2)],
			[4, f(2)],
			[5, f(5)],
		]),
	);
	expect(Object.fromEntries(ranks)).toEqual({ 2: 0, 3: 1 / 3, 4: 1 / 3, 5: 1 });
});
