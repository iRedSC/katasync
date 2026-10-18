import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import {
	createPurchasingDb,
	daysAgo,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";
import { recommendedAdditions, suggestPurchases } from "./reorder";

let db: Db;
let warehouse: number;
let canam: number;
let store: number;
const { stock, sell, supply } = purchasingBuilders(() => ({
	db,
	warehouse,
	canam,
	store,
}));

beforeEach(async () => {
	({ db, warehouse, canam, store } = await createPurchasingDb());
});

describe("recommendedAdditions", () => {
	test("lists what will need ordering within cover days, soonest first", async () => {
		const soon = await createProduct(db, "SOON", "simple");
		const later = await createProduct(db, "LATER", "simple");
		const far = await createProduct(db, "FAR", "simple");
		const now_ = await createProduct(db, "NOW", "simple");
		const onDraft = await createProduct(db, "ONDRAFT", "simple");
		for (const id of [soon, later, far, now_, onDraft]) await supply(id, 2);
		// Each sells 1 a day; lead time is 10, cover 20.
		for (const id of [soon, later, far, now_, onDraft]) await sell(id, 90);
		await stock(soon, 23);
		await stock(later, 30);
		await stock(far, 55);
		await stock(now_, 5);
		await stock(onDraft, 12);

		const r = await recommendedAdditions(db, canam, new Set([onDraft]), now);
		// All are A items whose sales came in one order, so safety stock is
		// capped at the lead time's 10: the reorder point is 20 and a top-up goes
		// to 40. NOW needs ordering today, so it's a suggestion instead; FAR
		// lasts past cover.
		expect(r.map((l) => [l.sku, l.due, l.quantity, l.critical])).toEqual([
			["SOON", 3, 17, true],
			["LATER", 10, 10, true],
		]);
	});

	test("puts C items that need ordering first, filled to max, instead of on the PO", async () => {
		const top = await createProduct(db, "TOP", "simple");
		const slow = await createProduct(db, "SLOW", "simple");
		const counted = await createProduct(db, "COUNTED", "simple");
		const dormant = await createProduct(db, "DORMANT", "simple");
		for (const id of [top, slow, counted, dormant]) await supply(id, 2);
		await sell(top, 90);
		await stock(top, 23); // due in 3 days, as above
		await sell(slow, 1); // a sliver of the margin: a C item
		await stock(counted, 1);
		await db
			.update(schema.stockLevels)
			.set({ lastCountedAt: daysAgo(30) })
			.where(eq(schema.stockLevels.productId, counted));
		// All three C items sit below a min of 3, so they need ordering.
		for (const id of [slow, counted, dormant])
			await db
				.update(schema.products)
				.set({ minStock: 3, maxStock: 12 })
				.where(eq(schema.products.id, id));

		expect(await suggestPurchases(db, now)).toEqual([]);

		const r = await recommendedAdditions(db, canam, new Set(), now);
		// DORMANT never sold and was never counted, so it's left out. The rest
		// fill to their max of 12, less what's on the shelf.
		expect(r.map((l) => [l.sku, l.due, l.quantity])).toEqual([
			["COUNTED", "now", 11],
			["SLOW", "now", 12],
			["TOP", 3, 17],
		]);
	});
});
