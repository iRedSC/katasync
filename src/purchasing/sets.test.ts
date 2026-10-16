import { describe, expect, test } from "vitest";
import { orderedItems, type SetPartInput, shortBySupplier } from "./sets";

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
