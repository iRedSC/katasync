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
	setUnavailable,
} from "./catalogs";
import {
	applySettings,
	draftFromSuggestions,
	lockDraftLine,
	restoreSettings,
	setDraftLine,
	settingsOf,
	updateFromSuggestions,
} from "./orders";
import {
	createPurchasingDb,
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
const { sell, linesOf } = purchasingBuilders(() => ({
	db,
	warehouse,
	canam,
	store,
}));

// Two suppliers carrying one catalog, "Tools", and a second supplier.
let tsw: number;
let tools: number;
beforeEach(async () => {
	({ db, warehouse, canam, store } = await createPurchasingDb());
	[{ id: tsw }] = await db
		.insert(schema.suppliers)
		.values({ code: "TSW", name: "TSW", leadTimeDays: 10, coverDays: 20 })
		.returning();
	tools = await ensureCatalog(db, "Tools");
	await setCarried(db, { supplierId: canam, catalogId: tools, carried: true });
	await setCarried(db, { supplierId: tsw, catalogId: tools, carried: true });
});

async function tool(sku: string) {
	const id = await createProduct(db, sku, "simple");
	await setProductsCatalog(db, [id], tools);
	return id;
}

const price = (productId: number, supplierId: number, cost: number | null) =>
	setSupplierTerms(db, { productId, supplierId, cost });

describe("buying from the cheapest supplier", () => {
	test("each product goes on the PO of whoever sells one for least", async () => {
		const blade = await tool("BLADE");
		const knife = await tool("KNIFE");
		await price(blade, canam, 5);
		await price(blade, tsw, 4);
		await price(knife, canam, 3);
		await price(knife, tsw, 6);
		await sell(blade, 90);
		await sell(knife, 90);

		const all = await suggestPurchases(db, now);
		const skus = (id: number) =>
			all.find((s) => s.supplierId === id)?.lines.map((l) => l.sku);
		expect(skus(canam)).toEqual(["KNIFE"]);
		expect(skus(tsw)).toEqual(["BLADE"]);
	});

	test("compares the price of a single item, not of a case", async () => {
		const blade = await tool("BLADE");
		// A case of 12 for $36 is $3 each, under Canam's $4.
		await setOfferTerms(db, blade, tsw, {
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			cost: 36,
		});
		await price(blade, canam, 4);
		await sell(blade, 90);
		const [s] = await suggestPurchases(db, now);
		expect(s).toMatchObject({ supplierId: tsw });
		expect(s.lines[0]).toMatchObject({ unit: "CASE", unitCost: 36 });
	});

	test("a priced supplier wins over one with no price", async () => {
		const blade = await tool("BLADE");
		await price(blade, tsw, 50);
		await sell(blade, 90);
		const [s] = await suggestPurchases(db, now);
		expect(s.supplierId).toBe(tsw);
	});

	test("a supplier that stops carrying the catalog stops selling it, and gets its prices back on return", async () => {
		const blade = await tool("BLADE");
		await price(blade, canam, 1);
		await price(blade, tsw, 9);
		await sell(blade, 90);
		await setCarried(db, {
			supplierId: canam,
			catalogId: tools,
			carried: false,
		});
		expect((await suggestPurchases(db, now))[0].supplierId).toBe(tsw);
		await setCarried(db, {
			supplierId: canam,
			catalogId: tools,
			carried: true,
		});
		const [s] = await suggestPurchases(db, now);
		expect(s).toMatchObject({ supplierId: canam });
		expect(s.lines[0].unitCost).toBe(1);
	});

	test("a product marked unavailable is bought elsewhere, and its price comes back when it's available again", async () => {
		const blade = await tool("BLADE");
		await price(blade, canam, 1);
		await price(blade, tsw, 9);
		await sell(blade, 90);
		const flip = (unavailable: boolean) =>
			setUnavailable(db, {
				supplierId: canam,
				productIds: [blade],
				unavailable,
			});
		expect(await flip(true)).toEqual([blade]);
		expect(await flip(true)).toEqual([]);
		expect((await suggestPurchases(db, now))[0].supplierId).toBe(tsw);
		await expect(price(blade, canam, 2)).rejects.toThrow(/unavailable/);
		expect(await flip(false)).toEqual([blade]);
		const [s] = await suggestPurchases(db, now);
		expect(s).toMatchObject({ supplierId: canam });
		expect(s.lines[0].unitCost).toBe(1);
	});

	test("refuses marking unavailable what the supplier doesn't sell anyway", async () => {
		const loose = await createProduct(db, "LOOSE", "simple");
		await expect(
			setUnavailable(db, {
				supplierId: canam,
				productIds: [loose],
				unavailable: true,
			}),
		).rejects.toThrow(/doesn't carry LOOSE's catalog/);
	});

	test("refuses terms from a supplier that doesn't carry the catalog", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		await expect(price(blade, canam, 1)).rejects.toThrow(/catalog first/);
		await setProductsCatalog(db, [blade], tools);
		await setCarried(db, {
			supplierId: canam,
			catalogId: tools,
			carried: false,
		});
		await expect(price(blade, canam, 1)).rejects.toThrow(/doesn't carry/);
	});
});

describe("a PO's own suggestion settings", () => {
	test("pricier items come in when asked for, and are recommended with who's cheaper otherwise", async () => {
		const blade = await tool("BLADE");
		await price(blade, canam, 5);
		await price(blade, tsw, 4);
		await sell(blade, 90);

		expect(await suggestionFor(db, canam, DEFAULT_SETTINGS, now)).toEqual([]);
		const [r] = await recommendedAdditions(
			db,
			canam,
			new Set(),
			DEFAULT_SETTINGS,
			now,
		);
		expect(r).toMatchObject({
			sku: "BLADE",
			due: "now",
			cheaperAt: { supplierId: tsw, supplierCode: "TSW", itemCost: 4, ours: 5 },
		});

		const pricier = { ...DEFAULT_SETTINGS, includePricier: true };
		const [line] = await suggestionFor(db, canam, pricier, now);
		expect(line).toMatchObject({ sku: "BLADE", unitCost: 5 });
		expect(
			await recommendedAdditions(db, canam, new Set(), pricier, now),
		).toEqual([]);
	});

	test("cover days and left-out catalogs change what's suggested", async () => {
		const blade = await tool("BLADE");
		const other = await ensureCatalog(db, "Other");
		await setCarried(db, {
			supplierId: canam,
			catalogId: other,
			carried: true,
		});
		const knife = await createProduct(db, "KNIFE", "simple");
		await setProductsCatalog(db, [knife], other);
		await price(blade, canam, 1);
		await price(knife, canam, 1);
		await sell(blade, 90);
		await sell(knife, 90);

		const base = await suggestionFor(db, canam, DEFAULT_SETTINGS, now);
		const longer = await suggestionFor(
			db,
			canam,
			{ ...DEFAULT_SETTINGS, coverDays: 60 },
			now,
		);
		const qty = (lines: typeof base, sku: string) =>
			lines.find((l) => l.sku === sku)?.quantity ?? 0;
		expect(qty(longer, "BLADE")).toBeGreaterThan(qty(base, "BLADE"));

		const noOther = await suggestionFor(
			db,
			canam,
			{ ...DEFAULT_SETTINGS, excludedCatalogs: [other] },
			now,
		);
		expect(noOther.map((l) => l.sku)).toEqual(["BLADE"]);
	});

	test("applying makes unlocked lines match, keeps locked ones, and undo puts everything back", async () => {
		const blade = await tool("BLADE");
		const knife = await tool("KNIFE");
		const handle = await tool("HANDLE");
		for (const id of [blade, knife, handle]) await price(id, canam, 1);
		await sell(blade, 90);
		await sell(knife, 90);
		const po = await draftFromSuggestions(db, canam, now);
		const before = await linesOf(po);
		// A hand-added line the suggestion doesn't want, and a locked one.
		await setDraftLine(db, {
			purchaseOrderId: po,
			productId: handle,
			quantity: 7,
		});
		await lockDraftLine(db, {
			purchaseOrderId: po,
			productId: knife,
			locked: true,
		});
		const knifeBefore = before.find((l) => l.productId === knife)?.quantity;

		const shorter = { ...DEFAULT_SETTINGS, coverDays: 1 };
		const r = await applySettings(db, po, shorter, now);
		expect(r).toMatchObject({ lowered: 1, removed: 1, added: 0 });
		const after = await linesOf(po);
		expect(after.map((l) => l.productId)).toEqual([blade, knife]);
		expect(after.find((l) => l.productId === knife)?.quantity).toBe(
			knifeBefore,
		);
		expect(await settingsOf(db, po)).toEqual(shorter);

		// Refresh only adds and raises: it leaves the lowered line alone.
		expect(await updateFromSuggestions(db, po, now)).toEqual({
			added: 0,
			raised: 0,
		});

		await restoreSettings(db, po, r.undo);
		expect(await settingsOf(db, po)).toEqual(DEFAULT_SETTINGS);
		const restored = await linesOf(po);
		expect(restored.map((l) => [l.productId, l.quantity, l.locked])).toEqual(
			[...before, { productId: handle, quantity: 7, locked: false }]
				.map((l) => [l.productId, l.quantity, l.productId === knife])
				.sort((a, b) => Number(a[0]) - Number(b[0])),
		);
	});

	test("won't leave every catalog out", async () => {
		const po = await draftFromSuggestions(db, canam, now);
		await expect(
			applySettings(
				db,
				po,
				{ ...DEFAULT_SETTINGS, excludedCatalogs: [tools] },
				now,
			),
		).rejects.toThrow(/at least one catalog/);
		const [row] = await db
			.select({ coverDays: schema.purchaseOrders.coverDays })
			.from(schema.purchaseOrders)
			.where(eq(schema.purchaseOrders.id, po));
		expect(row.coverDays).toBeNull();
	});
});

test("a product on another supplier's draft isn't suggested again", async () => {
	const blade = await tool("BLADE");
	await price(blade, canam, 5);
	await price(blade, tsw, 4);
	await sell(blade, 90);
	const pricier = { ...DEFAULT_SETTINGS, includePricier: true };
	const po = await draftFromSuggestions(db, canam, now);
	await applySettings(db, po, pricier, now);
	expect((await linesOf(po)).map((l) => l.productId)).toEqual([blade]);
	expect(await suggestionFor(db, tsw, DEFAULT_SETTINGS, now)).toEqual([]);
});

test("undo leaves a line changed since applying alone", async () => {
	const blade = await tool("BLADE");
	await price(blade, canam, 1);
	await sell(blade, 90);
	const po = await draftFromSuggestions(db, canam, now);
	const r = await applySettings(
		db,
		po,
		{ ...DEFAULT_SETTINGS, coverDays: 90 },
		now,
	);
	expect(r.raised).toBe(1);
	await setDraftLine(db, {
		purchaseOrderId: po,
		productId: blade,
		quantity: 2,
	});
	expect(await restoreSettings(db, po, r.undo)).toEqual({ kept: 1 });
	expect((await linesOf(po))[0].quantity).toBe(2);
});
