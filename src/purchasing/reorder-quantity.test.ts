import { describe, expect, test } from "vitest";
import { daysUntilReorder, reorderQuantity } from "./reorder";

describe("reorderQuantity", () => {
	const base = {
		dailyDemand: 1,
		onHand: 0,
		onOrder: 0,
		leadTimeDays: 10,
		safetyStock: 0,
		coverDays: 20,
		minStock: 0,
		setFloor: 0,
		minimumQuantity: 1,
		packSize: 1,
		supplierCount: 1,
	};

	test("orders once stock won't last until a new PO arrives", () => {
		expect(reorderQuantity({ ...base, onHand: 10 })).toBe(0);
		expect(reorderQuantity({ ...base, onHand: 9 })).toBe(21);
	});

	test("counts what's already on order", () => {
		expect(reorderQuantity({ ...base, onHand: 4, onOrder: 6 })).toBe(0);
		expect(reorderQuantity({ ...base, onHand: 4, onOrder: 5 })).toBe(21);
	});

	test("rounds up to the supplier's minimum", () => {
		expect(reorderQuantity({ ...base, onHand: 9, minimumQuantity: 30 })).toBe(
			30,
		);
	});

	test("orders whole packs, with the minimum counted in packs", () => {
		// 21 needed: one case of 30 covers it.
		expect(reorderQuantity({ ...base, onHand: 9, packSize: 30 })).toBe(1);
		expect(reorderQuantity({ ...base, onHand: 9, packSize: 10 })).toBe(3);
		expect(
			reorderQuantity({ ...base, onHand: 9, packSize: 30, minimumQuantity: 2 }),
		).toBe(2);
	});

	test("orders earlier, and more, by the safety stock", () => {
		// Reorder point 10 + 5; topped up to 30 + 5.
		expect(reorderQuantity({ ...base, safetyStock: 5, onHand: 15 })).toBe(0);
		expect(reorderQuantity({ ...base, safetyStock: 5, onHand: 14 })).toBe(21);
	});

	test("counts oversold stock as empty, since receiving writes it off", () => {
		expect(reorderQuantity({ ...base, onHand: -50 })).toBe(
			reorderQuantity(base),
		);
		// Still ordered with no sales, but only until something is coming.
		expect(reorderQuantity({ ...base, dailyDemand: 0, onHand: -2 })).toBe(1);
		expect(
			reorderQuantity({
				...base,
				dailyDemand: 0,
				onHand: -2,
				minimumQuantity: 6,
			}),
		).toBe(6);
		expect(
			reorderQuantity({ ...base, dailyDemand: 0, onHand: -2, onOrder: 1 }),
		).toBe(0);
		expect(
			reorderQuantity({ ...base, dailyDemand: 0, minStock: 3, onHand: -2 }),
		).toBe(3);
	});

	test("orders back up to min stock, even with no recent sales", () => {
		expect(reorderQuantity({ ...base, dailyDemand: 0, minStock: 3 })).toBe(3);
		expect(
			reorderQuantity({ ...base, dailyDemand: 0, minStock: 3, onHand: 2 }),
		).toBe(1);
		expect(
			reorderQuantity({ ...base, dailyDemand: 0, minStock: 3, onHand: 3 }),
		).toBe(0);
		// Min above the usual reorder point raises it: 15 on hand lasts the lead
		// time, but not past min.
		expect(reorderQuantity({ ...base, minStock: 20, onHand: 15 })).toBe(15);
	});

	test("keeps enough for one of each tool set, like min stock", () => {
		const idle = { ...base, dailyDemand: 0, setFloor: 3 };
		expect(reorderQuantity({ ...idle, onHand: 2 })).toBe(1);
		expect(reorderQuantity({ ...idle, onHand: 1, onOrder: 2 })).toBe(0);
		expect(reorderQuantity({ ...idle, onHand: 3 })).toBe(0);
	});

	test("counts days until it needs ordering", () => {
		expect(daysUntilReorder({ ...base, onHand: 15 })).toBe(5);
		expect(daysUntilReorder({ ...base, onHand: 10 })).toBe(0);
		expect(daysUntilReorder({ ...base, onHand: 9 })).toBeNull();
		expect(daysUntilReorder({ ...base, dailyDemand: 0 })).toBeNull();
	});
});
