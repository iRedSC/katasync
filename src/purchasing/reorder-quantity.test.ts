import { describe, expect, test } from "vitest";
import { daysUntilReorder, reorderQuantity } from "./reorder";
import { fillToMax } from "./reorder/quantity";

describe("reorderQuantity", () => {
	const base = {
		recentSold: 20,
		dailyDemand: 1,
		onHand: 0,
		onOrder: 0,
		coverDays: 30,
		minStock: 0,
		setFloor: 0,
		minimumQuantity: 1,
		packSize: 1,
	};

	test("tops stock up to what sold over the cover days", () => {
		// 4 sold last month, 3 on the shelf: one more, not a forecast's five.
		expect(reorderQuantity({ ...base, recentSold: 4, onHand: 3 })).toBe(1);
		expect(reorderQuantity({ ...base, onHand: 19 })).toBe(1);
		expect(reorderQuantity({ ...base, onHand: 20 })).toBe(0);
		expect(reorderQuantity({ ...base, onHand: 25 })).toBe(0);
	});

	test("counts everything on order, however late", () => {
		expect(reorderQuantity({ ...base, onHand: 4, onOrder: 16 })).toBe(0);
		expect(reorderQuantity({ ...base, onHand: 4, onOrder: 15 })).toBe(1);
	});

	test("orders nothing for what didn't sell", () => {
		expect(reorderQuantity({ ...base, recentSold: 0 })).toBe(0);
	});

	test("rounds up to the supplier's minimum", () => {
		expect(reorderQuantity({ ...base, onHand: 9, minimumQuantity: 30 })).toBe(
			30,
		);
	});

	test("orders whole packs, with the minimum counted in packs", () => {
		// 11 needed: one case of 30 covers it.
		expect(reorderQuantity({ ...base, onHand: 9, packSize: 30 })).toBe(1);
		expect(reorderQuantity({ ...base, onHand: 9, packSize: 10 })).toBe(2);
		expect(
			reorderQuantity({ ...base, onHand: 9, packSize: 30, minimumQuantity: 2 }),
		).toBe(2);
	});

	test("counts oversold stock as empty, since receiving writes it off", () => {
		expect(reorderQuantity({ ...base, onHand: -50 })).toBe(
			reorderQuantity(base),
		);
		// Still ordered with no sales, but only until something is coming.
		const idle = { ...base, recentSold: 0, dailyDemand: 0 };
		expect(reorderQuantity({ ...idle, onHand: -2 })).toBe(1);
		expect(reorderQuantity({ ...idle, onHand: -2, minimumQuantity: 6 })).toBe(
			6,
		);
		expect(reorderQuantity({ ...idle, onHand: -2, onOrder: 1 })).toBe(0);
		expect(reorderQuantity({ ...idle, minStock: 3, onHand: -2 })).toBe(3);
	});

	test("orders back up to min stock, even with no recent sales", () => {
		const idle = { ...base, recentSold: 0, dailyDemand: 0, minStock: 3 };
		expect(reorderQuantity(idle)).toBe(3);
		expect(reorderQuantity({ ...idle, onHand: 2 })).toBe(1);
		expect(reorderQuantity({ ...idle, onHand: 3 })).toBe(0);
		// Min above what sold sets the target.
		expect(reorderQuantity({ ...base, minStock: 25, onHand: 15 })).toBe(10);
	});

	test("keeps enough for one of each tool set, like min stock", () => {
		const idle = { ...base, recentSold: 0, dailyDemand: 0, setFloor: 3 };
		expect(reorderQuantity({ ...idle, onHand: 2 })).toBe(1);
		expect(reorderQuantity({ ...idle, onHand: 1, onOrder: 2 })).toBe(0);
		expect(reorderQuantity({ ...idle, onHand: 3 })).toBe(0);
	});

	test("counts days until it needs ordering, at its velocity", () => {
		expect(daysUntilReorder({ ...base, onHand: 25 })).toBe(5);
		expect(daysUntilReorder({ ...base, onHand: 20 })).toBe(0);
		expect(daysUntilReorder({ ...base, onHand: 19 })).toBeNull();
		expect(daysUntilReorder({ ...base, dailyDemand: 0 })).toBeNull();
	});

	test("fills to max from shelf plus on order", () => {
		expect(fillToMax({ ...base, onHand: 2, onOrder: 1 }, 5)).toBe(2);
		expect(fillToMax({ ...base, onHand: 5 }, 5)).toBe(0);
	});
});
