import { describe, expect, it } from "vitest";
import {
	monthlySpend,
	type OrderedLine,
	poCents,
	spendOf,
	topBought,
} from "#/purchasing/supplier-stats";

const line = (over: Partial<OrderedLine>): OrderedLine => ({
	purchaseOrderId: 1,
	supplierId: 1,
	status: "sent",
	sentAt: new Date("2026-09-10T15:00:00Z"),
	productId: 1,
	quantity: 2,
	packSize: 1,
	unitCost: 5,
	discounts: [],
	...over,
});

describe("spendOf", () => {
	it("counts sent and closed POs, after discounts, in single items", () => {
		const s = spendOf([
			line({ quantity: 2, packSize: 12, unitCost: 10 }),
			line({
				purchaseOrderId: 2,
				status: "closed",
				discounts: [{ units: "rest", off: { kind: "percent", percent: 50 } }],
			}),
			line({ purchaseOrderId: 3, status: "draft", sentAt: null }),
			line({ purchaseOrderId: 4, status: "cancelled" }),
		]);
		expect(s).toEqual({ cents: 2500, units: 26, pos: 2, unpriced: 0 });
	});

	it("leaves unpriced lines out of the money and says how many", () => {
		const s = spendOf([line({ unitCost: null }), line({ unitCost: 1 })]);
		expect(s.cents).toBe(200);
		expect(s.unpriced).toBe(1);
	});

	it("starts from `since`", () => {
		const s = spendOf(
			[line({ sentAt: new Date("2025-01-01") }), line({})],
			new Date("2026-01-01"),
		);
		expect(s.cents).toBe(1000);
	});
});

describe("monthlySpend", () => {
	it("buckets by the shop's month, oldest first, this month last", () => {
		const months = monthlySpend(
			[
				// 11pm Sept 30 in New York is October in UTC.
				line({ sentAt: new Date("2026-10-01T03:00:00Z") }),
				line({ sentAt: new Date("2026-10-05T12:00:00Z"), unitCost: 1 }),
			],
			new Date("2026-10-23T12:00:00Z"),
			3,
		);
		expect(months.map((m) => [m.label, m.cents])).toEqual([
			["Aug", 0],
			["Sep", 1000],
			["Oct", 200],
		]);
	});

	it("this month is the shop's, not UTC's", () => {
		// 9pm Oct 31 in New York.
		const october = monthlySpend([], new Date("2026-11-01T01:00:00Z"), 2);
		expect(october.map((m) => m.key)).toEqual(["2026-09", "2026-10"]);
		// 8pm Dec 31 in New York, across the year.
		const december = monthlySpend([], new Date("2027-01-01T01:00:00Z"), 13);
		expect(december[0].key).toBe("2025-12");
		expect(december.at(-1)?.key).toBe("2026-12");
	});
});

describe("topBought and poCents", () => {
	it("ranks products and totals POs", () => {
		const lines = [
			line({ productId: 1, quantity: 10, unitCost: 1 }),
			line({ productId: 2, quantity: 1, unitCost: 50 }),
			line({ productId: 2, purchaseOrderId: 2, quantity: 1, unitCost: 50 }),
		];
		expect(topBought(lines, "units", 5).map((p) => p.productId)).toEqual([
			1, 2,
		]);
		expect(topBought(lines, "cents", 1)).toEqual([
			{ productId: 2, units: 2, cents: 10000 },
		]);
		expect(poCents(lines).get(1)).toBe(6000);
	});
});
