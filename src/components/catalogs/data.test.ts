import { describe, expect, it } from "vitest";
import type { CatalogDetail } from "#/server/purchasing";
import { type CatalogProduct, withTerms } from "./data";

const offer = (supplierId: number) => ({
	productId: 0,
	supplierId,
	supplierSku: null,
	cost: 10,
	itemCost: 5,
	unit: "box",
	packSize: 2,
	minimumQuantity: 1,
	cheapest: true,
	breaks: [],
});
const product = (id: number) =>
	({
		id,
		offers: [offer(1), offer(2)],
		unavailable: [],
	}) as unknown as CatalogProduct;

const detail = (): CatalogDetail =>
	({
		catalog: {},
		carriers: [],
		soldDays: 30,
		products: [product(1), product(2), product(3)],
	}) as unknown as CatalogDetail;

describe("withTerms", () => {
	it("changes the price and the per-item cost of one offer", () => {
		const d = detail();
		const next = withTerms(d, 2, 1, { cost: 20 });
		expect(next.products[1]?.offers[0]).toMatchObject({
			cost: 20,
			itemCost: 10,
		});
		expect(next.products[1]?.offers[1]).toBe(d.products[1]?.offers[1]);
	});

	it("leaves every other product the same object, so its row isn't rendered again", () => {
		const d = detail();
		const next = withTerms(d, 2, 1, { supplierSku: "X" });
		expect(next.products[0]).toBe(d.products[0]);
		expect(next.products[2]).toBe(d.products[2]);
		expect(next.products[1]).not.toBe(d.products[1]);
		expect(next.carriers).toBe(d.carriers);
	});
});
