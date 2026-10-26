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
import {
	DEFAULT_SETTINGS,
	recommendedAdditions,
	suggestPurchases,
} from "./reorder";

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
		const leader = await createProduct(db, "LEADER", "simple");
		await supply(leader, 2);
		await sell(leader, 9000);
		const soon = await createProduct(db, "SOON", "simple");
		const later = await createProduct(db, "LATER", "simple");
		const far = await createProduct(db, "FAR", "simple");
		const now_ = await createProduct(db, "NOW", "simple");
		const onDraft = await createProduct(db, "ONDRAFT", "simple");
		for (const id of [soon, later, far, now_, onDraft]) await supply(id, 2);
		// Each sells 1 a day (90 in 90 days), 20 of it in the cover days.
		for (const id of [soon, later, far, now_, onDraft]) {
			await sell(id, 20);
			await sell(id, 70, { placedAt: daysAgo(40) });
		}
		await stock(soon, 23);
		await stock(later, 30);
		await stock(far, 55);
		await stock(now_, 5);
		await stock(onDraft, 12);
		// The default max is the cover-day sales (20), which SOON and LATER
		// already hold, so they get an explicit min and max.
		for (const id of [soon, later])
			await db
				.update(schema.products)
				.set({ minStock: 10, maxStock: 40 })
				.where(eq(schema.products.id, id));
		await db
			.update(schema.products)
			.set({ critical: true })
			.where(eq(schema.products.id, now_));

		const r = await recommendedAdditions(
			db,
			canam,
			new Set([onDraft]),
			DEFAULT_SETTINGS,
			now,
		);
		// The leader makes these C items. Each one's target is the 20 sold in
		// the cover days; SOON and LATER top up to their max of 40. NOW is
		// marked critical, so it's a suggestion instead; FAR lasts past cover.
		expect(r.map((l) => [l.sku, l.due, l.quantity, l.critical])).toEqual([
			["SOON", 3, 17, false],
			["LATER", 10, 10, false],
		]);
	});

	test("puts C items that need ordering first, filled to max, instead of on the PO", async () => {
		const top = await createProduct(db, "TOP", "simple");
		const slow = await createProduct(db, "SLOW", "simple");
		const counted = await createProduct(db, "COUNTED", "simple");
		const dormant = await createProduct(db, "DORMANT", "simple");
		for (const id of [top, slow, counted, dormant]) await supply(id, 2);
		// Sells 1 a day, 20 of it in the cover days: target 20, so it's above it.
		await sell(top, 20);
		await sell(top, 70, { placedAt: daysAgo(40) });
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

		const r = await recommendedAdditions(
			db,
			canam,
			new Set(),
			DEFAULT_SETTINGS,
			now,
		);
		// DORMANT never sold and was never counted, so it's left out. The rest
		// fill to their max of 12, less what's on the shelf.
		expect(r.map((l) => [l.sku, l.due, l.quantity])).toEqual([
			["COUNTED", "now", 11],
			["SLOW", "now", 12],
		]);
	});
});
