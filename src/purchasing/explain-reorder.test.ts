import { describe, expect, test } from "vitest";
import { averageCost } from "./orders";
import { explainReorder, reorderQuantity, velocityRanks } from "./reorder";

describe("explainReorder", () => {
	const base = {
		dailyDemand: 1,
		onHand: 0,
		onOrder: 0,
		leadTimeDays: 10,
		safetyStock: 4,
		coverDays: 20,
		minStock: 0,
		setFloor: 0,
		minimumQuantity: 1,
		packSize: 1,
		supplierCount: 1,
	};
	const context = {
		inStockDays: 90,
		rank: 0.5,
		leadTime: { days: 10, from: "supplier" as const, pos: 0 },
		abc: "B" as const,
		purchase: {
			unit: "EACH",
			packSize: 1,
			supplierCount: 1,
			minimumQuantity: 1,
		},
		sets: { shelf: 0, sets: [] },
	};

	test("breaks the aim into parts that add up to it", () => {
		const why = explainReorder({ ...base, dailyDemand: 0.73 }, context);
		if (why.aim.kind !== "forecast") throw new Error("expected forecast");
		const { restock, safetyStock, cover, total } = why.aim;
		expect(restock + safetyStock + cover).toBe(total);
		expect(why.orderBelow).toBe(restock + safetyStock);
	});

	test("orders what reorderQuantity orders, and says why it's rounded", () => {
		const input = {
			...base,
			onHand: 5,
			onOrder: 3,
			packSize: 12,
			supplierCount: 12,
		};
		const why = explainReorder(input, {
			...context,
			purchase: {
				unit: "CASE",
				packSize: 12,
				supplierCount: 12,
				minimumQuantity: 1,
			},
		});
		// Aim 34, have 8: short 26, so 3 cases of 12.
		expect(why.verdict).toEqual({
			kind: "order",
			quantity: reorderQuantity(input),
			units: 36,
			roundedUp: "pack",
		});
		expect(
			explainReorder({ ...base, minimumQuantity: 50 }, context).verdict,
		).toMatchObject({ quantity: 50, roundedUp: "minimum" });
	});

	test("waits, or does nothing, when stock covers the reorder point", () => {
		expect(explainReorder({ ...base, onHand: 20 }, context).verdict).toEqual({
			kind: "later",
			days: 6,
		});
		expect(
			explainReorder({ ...base, dailyDemand: 0, safetyStock: 0 }, context)
				.verdict,
		).toEqual({ kind: "idle" });
	});

	test("says when its tool sets, not min stock, set the floor", () => {
		const why = explainReorder(
			{ ...base, minStock: 40, setFloor: 50 },
			context,
		);
		expect(why).toMatchObject({
			aim: { kind: "min", total: 50, forecast: 34 },
			minStock: 50,
			minFrom: "sets",
			orderBelow: 50,
		});
		expect(
			explainReorder({ ...base, minStock: 50, setFloor: 50 }, context),
		).toMatchObject({ minStock: 50, minFrom: "stock" });
	});

	test("lets min stock set the aim when it's more than sales call for", () => {
		const why = explainReorder({ ...base, minStock: 50 }, context);
		expect(why.aim).toEqual({ kind: "min", total: 50, forecast: 34 });
		expect(why.orderBelow).toBe(50);
	});
});

test("velocityRanks spreads selling products from 0 to 1, ties sharing", () => {
	const f = (dailyDemand: number) => ({
		dailyDemand,
		dailySd: 0,
		inStockDays: 90,
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

test("averageCost weighs what's on the shelf against what arrived", () => {
	expect(
		averageCost({ oldCost: 10, onHandBefore: 10, quantity: 10, unitCost: 20 }),
	).toBe(15);
	expect(
		averageCost({ oldCost: 10, onHandBefore: -3, quantity: 5, unitCost: 20 }),
	).toBe(20);
	expect(
		averageCost({ oldCost: null, onHandBefore: 4, quantity: 5, unitCost: 7 }),
	).toBe(7);
});
