import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import {
	ensureCatalog,
	setCarried,
	setOfferTerms,
	setProductsCatalog,
} from "./catalogs";
import {
	applySettings,
	lockDraftLine,
	openDraft,
	openSuggested,
	previewSettings,
	restoreSettings,
	setDraftLine,
	settingsOf,
} from "./orders";
import {
	carry,
	createPurchasingDb,
	daysAgo,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";
import {
	DEFAULT_SETTINGS,
	recommendedAdditions,
	suggestionFor,
	suggestPurchases,
} from "./reorder";
import { setSupplierTerms } from "./suppliers";

let db: Db;
let warehouse: number;
let canam: number;
let store: number;
const { stock, sell, supply, linesOf } = purchasingBuilders(() => ({
	db,
	warehouse,
	canam,
	store,
}));
const longer = { ...DEFAULT_SETTINGS, coverDays: 90 };

beforeEach(async () => {
	({ db, warehouse, canam, store } = await createPurchasingDb());
	await db
		.update(schema.suppliers)
		.set({ coverDays: 30 })
		.where(eq(schema.suppliers.id, canam));
});

// Sold 30 in the last 30 days and 90 in the last 90, so the cover days
// decide how much it needs.
async function product(sku: string, onHand: number) {
	const id = await createProduct(db, sku, "simple");
	await supply(id, 2);
	await sell(id, 30);
	await sell(id, 60, { placedAt: daysAgo(60) });
	await stock(id, onHand);
	await db
		.update(schema.products)
		.set({ critical: true })
		.where(eq(schema.products.id, id));
	return id;
}

describe("PO cover horizon", () => {
	test("expanding 30 to 90 days previews and adds items that sold more over them, and undo restores both settings and lines", async () => {
		await product("DUE-1", 0);
		await product("DUE-2", 0);
		const future = await product("FUTURE", 40);
		await product("FAR", 100);
		const po = await openSuggested(db, canam, now);
		const before = await linesOf(po);
		expect(before).toHaveLength(2);
		const expected = { added: 1, raised: 2, lowered: 0, removed: 0 };
		expect(await previewSettings(db, po, longer, now)).toEqual({
			...expected,
			// DUE-1 and DUE-2 at 90 each, FUTURE at 50, all $2.
			total: 460,
			unpriced: 0,
		});
		expect(await linesOf(po)).toEqual(before);
		const applied = await applySettings(db, po, longer, now);
		expect(applied).toMatchObject(expected);
		expect(await linesOf(po)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ productId: future, quantity: 50 }),
			]),
		);
		expect(await linesOf(po)).toHaveLength(3);
		expect(await settingsOf(db, po)).toEqual(longer);
		expect(
			await recommendedAdditions(db, canam, new Set(), longer, now),
		).toEqual([]);
		await restoreSettings(db, po, applied.undo);
		expect(
			(await linesOf(po)).map(({ productId, quantity }) => ({
				productId,
				quantity,
			})),
		).toEqual(
			before.map(({ productId, quantity }) => ({ productId, quantity })),
		);
		expect(await settingsOf(db, po)).toEqual(DEFAULT_SETTINGS);
	});

	test("shortening cover removes lines it no longer needs but preserves locked lines", async () => {
		const future = await product("FUTURE", 40);
		const locked = await product("LOCKED", 40);
		const po = await openSuggested(db, canam, now);
		await applySettings(db, po, longer, now);
		await lockDraftLine(db, {
			purchaseOrderId: po,
			productId: locked,
			locked: true,
		});
		expect(await applySettings(db, po, DEFAULT_SETTINGS, now)).toMatchObject({
			removed: 1,
		});
		expect((await linesOf(po)).map((line) => line.productId)).toEqual([locked]);
		expect((await linesOf(po)).some((line) => line.productId === future)).toBe(
			false,
		);
	});

	test("longer cover respects excluded catalogs and uncounted inventory", async () => {
		const included = await product("INCLUDED", 40);
		const excluded = await product("EXCLUDED", 40);
		const uncounted = await product("UNCOUNTED", 40);
		const catalogId = await ensureCatalog(db, "Excluded");
		await setCarried(db, { supplierId: canam, catalogId, carried: true });
		await setProductsCatalog(db, [excluded], catalogId);
		await db
			.update(schema.products)
			.set({ notCountedSince: now })
			.where(eq(schema.products.id, uncounted));
		const settings = { ...longer, excludedCatalogs: [catalogId] };
		expect(
			(await suggestionFor(db, canam, settings, now)).map(
				(line) => line.productId,
			),
		).toEqual([included]);
	});

	test("longer cover respects cheapest supplier settings and other suppliers' drafts", async () => {
		const future = await product("FUTURE", 40);
		const [{ id: other }] = await db
			.insert(schema.suppliers)
			.values({ code: "OTHER", name: "Other", leadTimeDays: 10 })
			.returning();
		const catalogId = await carry(db, future, other);
		await setCarried(db, { supplierId: canam, catalogId, carried: true });
		await setSupplierTerms(db, {
			productId: future,
			supplierId: other,
			cost: 1,
		});
		expect(await suggestionFor(db, canam, longer, now)).toEqual([]);
		const settings = { ...longer, includePricier: true };
		expect(await suggestionFor(db, canam, settings, now)).toMatchObject([
			{ productId: future, quantity: 50 },
		]);
		const po = await openDraft(db, other);
		await setDraftLine(db, {
			purchaseOrderId: po,
			productId: future,
			quantity: 1,
		});
		expect(await suggestionFor(db, canam, settings, now)).toEqual([]);
	});

	test("longer cover quantities use whole supplier packs and minimums", async () => {
		// 30 short of 90: 3 cases of 12, raised to the minimum of 4.
		const future = await product("FUTURE", 60);
		await setOfferTerms(db, future, canam, {
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			cost: 24,
			minimumQuantity: 4,
		});
		expect(await suggestionFor(db, canam, longer, now)).toMatchObject([
			{ productId: future, packSize: 12, quantity: 4 },
		]);
	});

	test("coverage changes PO composition without making the supplier due now", async () => {
		const future = await product("FUTURE", 40);
		expect(await suggestPurchases(db, now)).toEqual([]);
		expect(await suggestionFor(db, canam, DEFAULT_SETTINGS, now)).toEqual([]);
		expect(await suggestionFor(db, canam, longer, now)).toMatchObject([
			{ productId: future, quantity: 50 },
		]);
	});
});
