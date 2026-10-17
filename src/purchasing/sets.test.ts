import { describe, expect, test } from "vitest";
import {
	orderedItems,
	partRole,
	type SetPartInput,
	setFloorOf,
	setMembership,
	setsBlocked,
	setsLimited,
	shortBySupplier,
} from "./sets";

const part = (p: Partial<SetPartInput>): SetPartInput => ({
	lineId: 1,
	productId: 10,
	perSet: 1,
	supplierId: 1,
	skipped: false,
	packSize: 1,
	elsewhere: [],
	...p,
});
const set = { id: 1, productId: 100, kind: "bundle", quantity: 3, packSize: 1 };

describe("orderedItems", () => {
	test("adds a product's line and its sets' parts, rounding up once", () => {
		const pump = {
			id: 2,
			productId: 10,
			kind: "simple",
			quantity: 1,
			packSize: 4,
		};
		const set2 = { ...set, id: 3, productId: 101, quantity: 1 };
		const parts = [part({ packSize: 4 }), part({ lineId: 3, packSize: 4 })];
		// 4 + 3 + 1 = 8, exactly two packs; rounding each set apart would be 12.
		expect(orderedItems([pump, set, set2], parts, 1).get(10)).toBe(8);
		// While the set is dragged to 4: 4 + 4 + 1 = 9, three packs.
		expect(
			orderedItems([pump, set, set2], parts, 1, new Map([[1, 4]])).get(10),
		).toBe(12);
	});

	test("leaves out parts bought elsewhere or skipped", () => {
		const parts = [
			part({ productId: 10 }),
			part({ productId: 11, supplierId: 2 }),
			part({ productId: 12, skipped: true }),
		];
		expect([...orderedItems([set], parts, 1)]).toEqual([[10, 3]]);
	});
});

test("shortBySupplier asks each supplier for what its least-covered part lacks", () => {
	const draft = (sets: number) => ({
		purchaseOrderId: 9,
		status: "draft" as const,
		sets,
	});
	const parts = [
		part({ productId: 11, supplierId: 2, elsewhere: [draft(1)] }),
		part({ productId: 12, supplierId: 2, elsewhere: [draft(2)] }),
		part({ productId: 13, supplierId: 3, elsewhere: [draft(3)] }),
		part({ productId: 14, supplierId: null }),
	];
	expect([...shortBySupplier(parts, 3, 1)]).toEqual([[2, 2]]);
});

describe("setMembership", () => {
	const set = (sku: string) => ({
		sku,
		name: sku,
		variantName: null,
		imageUrl: null,
	});
	// A takes 1 blade and 1 knife; B takes 2 blades; C takes 1 knife.
	const recipes = [
		{ setId: 1, productId: 10, perSet: 1, set: set("A") },
		{ setId: 1, productId: 20, perSet: 1, set: set("A") },
		{ setId: 2, productId: 10, perSet: 2, set: set("B") },
		{ setId: 3, productId: 20, perSet: 1, set: set("C") },
	];

	test("sells what the scarcest part builds, and says who holds each back", () => {
		// 1 blade, 5 knives: A sells 1 (blade limits), B none (blade blocks).
		const m = setMembership(
			recipes,
			new Map([
				[10, 1],
				[20, 5],
			]),
			new Map([[3, 4]]),
		);
		const blade = m.get(10);
		const knife = m.get(20);
		if (!blade || !knife) throw new Error("expected both");
		expect(
			blade.sets.map((s) => [s.sku, s.sellable, partRole(blade, s)]),
		).toEqual([
			["B", 0, "blocks"],
			["A", 1, "limits"],
		]);
		expect(setsBlocked(blade)).toBe(1);
		expect(setsLimited(blade)).toBe(2);
		// Knife holds back neither; C sold best, so it leads.
		expect(knife.sets.map((s) => [s.sku, s.sold, partRole(knife, s)])).toEqual([
			["C", 4, "limits"],
			["A", 0, "free"],
		]);
		expect(setFloorOf(blade)).toBe(2);
	});

	test("counts oversold as none", () => {
		const m = setMembership(recipes, new Map([[10, -2]]), new Map());
		expect(m.get(10)?.shelf).toBe(0);
		expect(m.get(20)?.sets.every((s) => s.sellable === 0)).toBe(true);
	});
});
