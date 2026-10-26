import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import * as schema from "#/db/capability-schema";
import type { Db } from "#/db/client";
import { createProduct } from "#/test/db";
import { bulkPricesOf, setBulkPrices } from "./bulk-prices";
import { markSent, openDraft, receive, setDraftLine } from "./orders";
import {
	createPurchasingDb,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";
import { setPurchaseUnit } from "./units";

let db: Db;
let warehouse: number;
let canam: number;
let store: number;
const { supply, linesOf } = purchasingBuilders(() => ({
	db,
	warehouse,
	canam,
	store,
}));

let blade: number;

beforeEach(async () => {
	({ db, warehouse, canam, store } = await createPurchasingDb());
	blade = await createProduct(db, "BLADE", "simple");
	await supply(blade, 10);
	await setBulkPrices(db, {
		productId: blade,
		supplierId: canam,
		breaks: [
			{ minQuantity: 10, cost: 8 },
			{ minQuantity: 25, cost: 7 },
		],
	});
});

const breaks = async () =>
	(await bulkPricesOf(db, [blade])).map(({ minQuantity, cost }) => ({
		minQuantity,
		cost,
	}));

const price = async (id: number) => (await linesOf(id))[0].unitCost;

describe("bulk prices", () => {
	test("refuses ones that never apply or cost more than fewer", async () => {
		await expect(
			setBulkPrices(db, {
				productId: blade,
				supplierId: canam,
				breaks: [{ minQuantity: 5, cost: 11 }],
			}),
		).rejects.toThrow("must be under 10");
		await expect(
			setBulkPrices(db, {
				productId: blade,
				supplierId: canam,
				breaks: [{ minQuantity: 1, cost: 9 }],
			}),
		).rejects.toThrow("just the price");
		expect(await breaks()).toHaveLength(2);
	});

	test("a draft line follows them as its quantity changes", async () => {
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 4,
		});
		expect(await price(id)).toBe(10);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 12,
		});
		expect(await price(id)).toBe(8);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 30,
		});
		expect(await price(id)).toBe(7);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 3,
		});
		expect(await price(id)).toBe(10);
	});

	test("a new line starts at the price for its quantity", async () => {
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 12,
		});
		expect(await price(id)).toBe(8);
	});

	test("a price set by hand stays when the quantity changes", async () => {
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 12,
			unitCost: 9.5,
		});
		expect(await price(id)).toBe(9.5);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 30,
		});
		expect(await price(id)).toBe(9.5);
	});

	test("a sent line keeps the price it was sent at", async () => {
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 12,
		});
		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		await setBulkPrices(db, {
			productId: blade,
			supplierId: canam,
			breaks: [],
		});
		expect(await price(id)).toBe(8);
	});

	test("receiving at a bulk price updates that one, not the price", async () => {
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 12,
			unitCost: 7.5,
		});
		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		const [line] = await linesOf(id);
		await receive(db, { lineId: line.id, quantity: 12 });
		expect(await breaks()).toEqual([
			{ minQuantity: 10, cost: 7.5 },
			{ minQuantity: 25, cost: 7 },
		]);
		const [link] = await db
			.select()
			.from(schema.productSuppliers)
			.where(eq(schema.productSuppliers.productId, blade));
		expect(link.cost).toBe(10);
	});

	test("changing the pack size converts them", async () => {
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "CASE",
			packSize: 5,
			supplierCount: 5,
			minimumQuantity: 1,
		});
		// From 10 each is from 2 cases of 5, at 5 × $8.
		expect(await breaks()).toEqual([
			{ minQuantity: 2, cost: 40 },
			{ minQuantity: 5, cost: 35 },
		]);
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 2,
		});
		expect(await price(id)).toBe(40);
	});

	test("the pack size can't change around them", async () => {
		await expect(
			db
				.update(schema.productSuppliers)
				.set({ unit: "CASE", packSize: 5, supplierCount: 5 })
				.where(eq(schema.productSuppliers.productId, blade)),
		).rejects.toThrow();
	});
});
