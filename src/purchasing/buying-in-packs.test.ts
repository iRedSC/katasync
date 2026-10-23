import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { formatOrderQuantity } from "#/lib/format";
import { createProduct } from "#/test/db";
import { loadOrder, printedLines } from "./load";
import {
	draftFromSuggestions,
	markSent,
	openDraft,
	receive,
	setDraftLine,
	updateFromSuggestions,
} from "./orders";
import {
	createPurchasingDb,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";
import { unitsOnOrder } from "./reorder";
import {
	addUnit,
	deleteUnit,
	listUnits,
	renameUnit,
	setLineTerms,
	setPurchaseUnit,
} from "./units";

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

beforeEach(async () => {
	({ db, warehouse, canam, store } = await createPurchasingDb());
});

describe("buying in packs", () => {
	let blade: number;

	beforeEach(async () => {
		blade = await createProduct(db, "BLADE", "simple");
		await supply(blade, 2);
		await db
			.update(schema.products)
			.set({ unitCost: 2 })
			.where(eq(schema.products.id, blade));
		await stock(blade, 10);
		await sell(blade, 120);
	});

	test("changing the unit converts the price and draft lines", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		// 120 sold in 90 days for 10 + 20 days, plus safety capped at the lead
		// time's demand (an A item), less 10 on hand: 44 to order.
		expect(await linesOf(id)).toMatchObject([
			{
				unit: "EACH",
				packSize: 1,
				supplierCount: 1,
				quantity: 44,
				unitCost: 2,
			},
		]);
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 1,
		});
		// 44 blades round up to 4 cases of 12, at 12 × $2.
		expect(await linesOf(id)).toMatchObject([
			{
				unit: "CASE",
				packSize: 12,
				supplierCount: 12,
				quantity: 4,
				unitCost: 24,
			},
		]);
		const [link] = await db.select().from(schema.productSuppliers);
		expect(link).toMatchObject({
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			cost: 24,
		});
		// The draft already has enough, so nothing more is suggested.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 0,
		});
	});

	test("receiving a case puts its contents on the shelf at the per-unit cost", async () => {
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 1,
		});
		const id = await draftFromSuggestions(db, canam, now);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 3,
			unitCost: 36,
		});
		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		expect((await unitsOnOrder(db)).get(blade)).toBe(36);

		const [line] = await linesOf(id);
		await receive(db, { lineId: line.id, quantity: 1 });
		const [level] = await db
			.select()
			.from(schema.stockLevels)
			.where(eq(schema.stockLevels.productId, blade));
		expect(level.onHand).toBe(22);
		expect((await unitsOnOrder(db)).get(blade)).toBe(24);
		const [product] = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, blade));
		// 10 on the shelf at $2, 12 more at $36 / 12 = $3.
		expect(product.unitCost).toBeCloseTo((10 * 2 + 12 * 3) / 22, 4);
		const [link] = await db.select().from(schema.productSuppliers);
		expect(link.cost).toBe(36);

		// A sent PO keeps its unit when the product's changes.
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "EACH",
			packSize: 1,
			supplierCount: 1,
			minimumQuantity: 1,
		});
		expect((await linesOf(id))[0]).toMatchObject({ unit: "CASE", quantity: 3 });
	});

	test("terms set on one PO stay on that PO unless made the default", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		const terms = {
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 2,
		};
		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			...terms,
			makeDefault: false,
		});
		expect(await linesOf(id)).toMatchObject([
			{ ...terms, quantity: 4, unitCost: 24 },
		]);
		const [link] = await db.select().from(schema.productSuppliers);
		expect(link).toMatchObject({
			unit: "EACH",
			packSize: 1,
			supplierCount: 1,
			cost: 2,
		});
		// 44 wanted is 4 cases: already enough, though the units differ.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 0,
		});
		// A default change leaves a line with its own terms alone.
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "CASE",
			packSize: 6,
			supplierCount: 6,
			minimumQuantity: 1,
		});
		expect((await linesOf(id))[0]).toMatchObject(terms);

		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			unit: "PACK",
			packSize: 4,
			supplierCount: 4,
			minimumQuantity: 5,
			makeDefault: true,
		});
		const [after] = await db.select().from(schema.productSuppliers);
		// $2 each was $12 a box of 6; a pack of 4 is $8.
		expect(after).toMatchObject({
			unit: "PACK",
			packSize: 4,
			supplierCount: 4,
			minimumQuantity: 5,
			cost: 8,
		});
		// 4 cases of 12 is 48, or 12 packs of 4.
		expect((await linesOf(id))[0]).toMatchObject({
			unit: "PACK",
			quantity: 12,
		});
	});

	test("a converted line is raised to the new minimum", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		expect(await linesOf(id)).toMatchObject([{ unit: "EACH", quantity: 44 }]);
		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 5,
			makeDefault: false,
		});
		// 44 blades are 4 cases, but the supplier won't sell fewer than 5.
		expect(await linesOf(id)).toMatchObject([
			{
				unit: "CASE",
				packSize: 12,
				supplierCount: 12,
				quantity: 5,
				minimumQuantity: 5,
			},
		]);
	});

	test("a line set in items converts with the terms it's written with", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 2,
			makeDefault: false,
		});
		// 25 items is 3 cases of 12, not 25 or 2.
		expect(
			await setDraftLine(db, {
				purchaseOrderId: id,
				productId: blade,
				quantity: 25,
				inItems: true,
			}),
		).toEqual({
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 2,
			quantity: 3,
		});
		expect((await linesOf(id))[0]).toMatchObject({ unit: "CASE", quantity: 3 });

		// Terms changed in between are used by the next call.
		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			unit: "CASE",
			packSize: 6,
			supplierCount: 6,
			minimumQuantity: 1,
			makeDefault: false,
		});
		const { quantity } = await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 24,
			inItems: true,
		});
		expect(quantity).toBe(4);
		expect((await linesOf(id))[0]).toMatchObject({ unit: "CASE", quantity: 4 });

		// A new line starts with the supplier's terms; no items removes it.
		const knife = await createProduct(db, "KNIFE", "simple");
		await supply(knife, 2);
		const added = await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 7,
			inItems: true,
		});
		expect(added).toMatchObject({
			unit: "EACH",
			packSize: 1,
			supplierCount: 1,
			quantity: 7,
		});
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 0,
			inItems: true,
		});
		expect(await linesOf(id)).toHaveLength(1);
	});

	test("raises a line in its own unit, rounding up", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 1,
			makeDefault: false,
		});
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 1,
		});
		// 44 wanted, 12 on the PO: raised to 4 cases.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 1,
		});
		expect((await linesOf(id))[0].quantity).toBe(4);
	});

	test("only a supplier that sells it can take a PO's terms as its default", async () => {
		const [{ id: other }] = await db
			.insert(schema.suppliers)
			.values({ code: "OTHER", name: "Other" })
			.returning();
		const po = await openDraft(db, other);
		await setDraftLine(db, {
			purchaseOrderId: po,
			productId: blade,
			quantity: 5,
		});
		await expect(
			setLineTerms(db, {
				purchaseOrderId: po,
				productId: blade,
				unit: "CASE",
				packSize: 12,
				supplierCount: 12,
				minimumQuantity: 1,
				makeDefault: true,
			}),
		).rejects.toThrow(/doesn't carry its catalog/);
		// Nothing changed, the line included.
		expect((await linesOf(po))[0]).toMatchObject({ unit: "EACH", quantity: 5 });
	});

	// PGlite has one connection, so a race can't be staged. These pin the
	// statements that keep it from happening.
	function logged() {
		const queries: string[] = [];
		const client = (db as unknown as { $client: PGlite }).$client;
		const logging = drizzle(client, {
			schema,
			casing: "snake_case",
			logger: { logQuery: (query) => queries.push(query) },
		});
		return { logging, queries };
	}

	test("receiving converts the cost in the one statement that reads the pack size", async () => {
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 1,
		});
		const id = await draftFromSuggestions(db, canam, now);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 3,
			unitCost: 36,
		});
		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		const [line] = await linesOf(id);

		const { logging, queries } = logged();
		await receive(logging, { lineId: line.id, quantity: 1 });

		expect(
			queries.filter((q) => /^select .* from "product_suppliers"/.test(q)),
		).toEqual([]);
		const writes = queries.filter((q) =>
			/^\s*insert into "product_suppliers"/.test(q),
		);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain('"pack_size"');
	});

	test("a default change locks draft POs, lowest first, before the supplier row", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		const { logging, queries } = logged();
		await setPurchaseUnit(logging, {
			productId: blade,
			supplierId: canam,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 1,
		});

		const locks = queries.filter((q) => q.endsWith("for update"));
		const poLock = locks.findIndex((q) => q.includes('from "purchase_orders"'));
		const supplierLock = locks.findIndex((q) =>
			q.includes('from "product_suppliers"'),
		);
		expect(poLock).toBeGreaterThanOrEqual(0);
		expect(poLock).toBeLessThan(supplierLock);
		expect(locks[poLock]).toContain('order by "purchase_orders"."id"');
		expect((await linesOf(id))[0]).toMatchObject({ unit: "CASE", quantity: 4 });
	});

	test("a supplier's PACK of 5 can be one of ours: the PO says 5, stock gets 1", async () => {
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "PACK",
			packSize: 1,
			supplierCount: 5,
			minimumQuantity: 1,
		});
		const id = await draftFromSuggestions(db, canam, now);
		// 44 to order, one of ours per pack, at the product's own $2 a pack.
		expect(await linesOf(id)).toMatchObject([
			{
				unit: "PACK",
				packSize: 1,
				supplierCount: 5,
				quantity: 44,
				unitCost: 2,
			},
		]);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 3,
			unitCost: 2,
		});
		const order = await loadOrder(db, id);
		expect(printedLines(order.lines, null)).toMatchObject([
			{ unit: "PACK", supplierCount: 5, quantity: 3 },
		]);
		expect(formatOrderQuantity(order.lines[0])).toBe(
			"3 PACK of 5 (counts as 3)",
		);

		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		expect((await unitsOnOrder(db)).get(blade)).toBe(3);
		const [line] = await linesOf(id);
		await receive(db, { lineId: line.id, quantity: 1 });
		const [level] = await db
			.select()
			.from(schema.stockLevels)
			.where(eq(schema.stockLevels.productId, blade));
		expect(level.onHand).toBe(11);
	});

	test("changing only the supplier's count leaves quantity and price alone", async () => {
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "PACK",
			packSize: 1,
			supplierCount: 1,
			minimumQuantity: 1,
		});
		const id = await draftFromSuggestions(db, canam, now);
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "PACK",
			packSize: 1,
			supplierCount: 5,
			minimumQuantity: 1,
		});
		// The draft line was on the default, so it follows it.
		expect(await linesOf(id)).toMatchObject([
			{ packSize: 1, supplierCount: 5, quantity: 44, unitCost: 2 },
		]);
		const [link] = await db.select().from(schema.productSuppliers);
		expect(link).toMatchObject({ packSize: 1, supplierCount: 5, cost: 2 });
		await expect(
			setPurchaseUnit(db, {
				productId: blade,
				supplierId: canam,
				unit: "EACH",
				packSize: 1,
				supplierCount: 5,
				minimumQuantity: 1,
			}),
		).rejects.toThrow(/one of the product/);
	});

	test("EACH holds one, and the unit list guards what's in use", async () => {
		await expect(
			setPurchaseUnit(db, {
				productId: blade,
				supplierId: canam,
				unit: "EACH",
				packSize: 6,
				supplierCount: 6,
				minimumQuantity: 1,
			}),
		).rejects.toThrow(/one of the product/);
		await expect(renameUnit(db, "EACH", "UNIT")).rejects.toThrow(/EACH/);
		await expect(deleteUnit(db, "EACH")).rejects.toThrow(/EACH/);

		expect(await addUnit(db, "  bag  of 50 ")).toBe("BAG OF 50");
		await expect(addUnit(db, "bag of 50")).rejects.toThrow(/already/);
		await setPurchaseUnit(db, {
			productId: blade,
			supplierId: canam,
			unit: "BAG OF 50",
			packSize: 50,
			supplierCount: 50,
			minimumQuantity: 1,
		});
		const id = await draftFromSuggestions(db, canam, now);
		await expect(deleteUnit(db, "BAG OF 50")).rejects.toThrow(/BLADE/);

		await renameUnit(db, "BAG OF 50", "Sack");
		const [link] = await db.select().from(schema.productSuppliers);
		expect(link.unit).toBe("SACK");
		expect((await linesOf(id))[0].unit).toBe("SACK");
		expect((await listUnits(db)).map((u) => [u.name, u.products])).toEqual([
			["EACH", 0],
			["BOX", 0],
			["CASE", 0],
			["PACK", 0],
			["SACK", 1],
		]);
	});
});
