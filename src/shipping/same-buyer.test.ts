import { describe, expect, it } from "vitest";
import { sameBuyerGroups } from "./same-buyer";

const order = (id: number, buyerId: string | null, storeId = 1) => ({
	id,
	name: `#${id}`,
	pin: id,
	marketplaceOrderId: `tiktok:${id}`,
	storeId,
	buyerId,
});

describe("sameBuyerGroups", () => {
	it("pairs each order with the buyer's others", () => {
		const groups = sameBuyerGroups(
			[order(1, "a"), order(2, "a"), order(3, "a"), order(4, "b")],
			[],
		);
		expect(groups.get(1)?.map((o) => o.id)).toEqual([2, 3]);
		expect(groups.get(3)?.map((o) => o.id)).toEqual([1, 2]);
		expect(groups.has(4)).toBe(false);
	});

	it("never groups orders with no buyer", () => {
		expect(sameBuyerGroups([order(1, null), order(2, null)], []).size).toBe(0);
	});

	it("keeps stores apart", () => {
		expect(sameBuyerGroups([order(1, "a", 1), order(2, "a", 2)], []).size).toBe(
			0,
		);
	});

	it("leaves out orders that already have a label", () => {
		const groups = sameBuyerGroups(
			[order(1, "a"), order(2, "a"), order(3, "a")],
			[{ orderId: 3 }],
		);
		expect(groups.get(1)?.map((o) => o.id)).toEqual([2]);
		expect(groups.has(3)).toBe(false);
		expect(
			sameBuyerGroups([order(1, "a"), order(2, "a")], [{ orderId: 2 }]).size,
		).toBe(0);
	});
});
