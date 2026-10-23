import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { setRecipe } from "#/inventory/recipes";
import { createProduct } from "#/test/db";
import {
	createPurchasingDb,
	daysAgo,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";
import {
	DEFAULT_SETTINGS,
	loadPlan,
	openArrivals,
	recommendedAdditions,
	reorderBreakdown,
	suggestPurchases,
} from "./reorder";
import { setsBlocked } from "./sets";

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

describe("reorderBreakdown", () => {
	test("uses promised PO dates and exposes backordered and missing-date supply", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		await supply(blade, 1);
		await stock(blade, 5);
		const [po] = await db
			.insert(schema.purchaseOrders)
			.values({
				supplierId: canam,
				locationId: warehouse,
				status: "sent",
				sentAt: daysAgo(1),
				expectedAt: new Date(now.getTime() + 60 * 86_400_000),
			})
			.returning();
		const [line] = await db
			.insert(schema.purchaseOrderLines)
			.values({
				purchaseOrderId: po.id,
				productId: blade,
				quantity: 100,
				supplierCount: 1,
				minimumQuantity: 1,
			})
			.returning();
		const plan = await loadPlan(db, now);
		plan.forecasts.set(blade, {
			dailyDemand: 1,
			dailySd: 0,
			inStockDays: 90,
		});
		const read = async () =>
			(await reorderBreakdown(db, { now, plan, productIds: [blade] }))[0];
		const late = await read();
		expect(late.why.incoming).toEqual({
			timely: 0,
			aim: 0,
			unknown: 0,
			lateDue: 60,
		});
		expect(late.line.quantity).toBeGreaterThan(0);
		await db
			.update(schema.purchaseOrders)
			.set({ expectedAt: new Date(now.getTime() + 3 * 86_400_000) })
			.where(eq(schema.purchaseOrders.id, po.id));
		const timely = await read();
		expect(timely.why.incoming.timely).toBe(100);
		expect(timely.line.quantity).toBe(0);
		await db
			.update(schema.purchaseOrderLines)
			.set({ backOrderedAt: now })
			.where(eq(schema.purchaseOrderLines.id, line.id));
		expect((await read()).why.incoming.unknown).toBe(100);
		await db
			.update(schema.purchaseOrderLines)
			.set({ backOrderedAt: null })
			.where(eq(schema.purchaseOrderLines.id, line.id));
		await db
			.update(schema.purchaseOrders)
			.set({ expectedAt: null, sentAt: null })
			.where(eq(schema.purchaseOrders.id, po.id));
		expect((await openArrivals(db, now, plan.leadTimes)).get(blade)).toEqual([
			{ units: 100, arrivesAt: null },
		]);
	});

	test("explains products without a supplier, but never orders them", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const loose = await createProduct(db, "LOOSE", "simple");
		await supply(blade, 1);
		await sell(blade, 90);
		await sell(loose, 90);

		const all = await reorderBreakdown(db, { now });
		const of = (id: number) => all.find((b) => b.line.productId === id);
		expect(of(blade)?.why).toMatchObject({
			purchase: { unit: "EACH", packSize: 1, supplierCount: 1 },
			leadTime: { from: "supplier" },
			verdict: { kind: "order" },
		});
		expect(of(loose)?.supplier).toBeNull();
		expect(of(loose)?.why).toMatchObject({
			purchase: null,
			leadTime: { days: 14, from: "default" },
			verdict: { kind: "order" },
		});
		const [s] = await suggestPurchases(db, now);
		expect(s.lines.map((l) => l.sku)).toEqual(["BLADE"]);

		const only = await reorderBreakdown(db, { now, productIds: [loose] });
		expect(only.map((b) => b.line.sku)).toEqual(["LOOSE"]);
	});
});

describe("tool set parts", () => {
	test("a C part that leaves a set unsellable goes on the PO by itself", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		const loner = await createProduct(db, "LONER", "simple");
		const set = await createProduct(db, "SET", "bundle");
		const other = await createProduct(db, "OTHER", "bundle");
		await setRecipe(db, set, [
			{ productId: blade, quantity: 2 },
			{ productId: knife, quantity: 1 },
		]);
		await setRecipe(db, other, [{ productId: blade, quantity: 3 }]);
		for (const id of [blade, knife, loner]) await supply(id, 2);
		await stock(knife, 1);
		await stock(blade, 1);
		// LONER is short of min stock too, but in no set. Counted, so it isn't
		// dormant.
		await stock(loner, 1);
		await db
			.update(schema.stockLevels)
			.set({ lastCountedAt: daysAgo(30) })
			.where(eq(schema.stockLevels.productId, loner));
		await db
			.update(schema.products)
			.set({ minStock: 2, maxStock: 4 })
			.where(eq(schema.products.id, loner));

		const all = await reorderBreakdown(db, { now });
		const of = (id: number) => all.find((b) => b.line.productId === id);
		// Never sold, so all C items. Blade can build neither set.
		const sets = (id: number) => {
			const m = of(id)?.why.sets;
			return m && { in: m.sets.map((x) => x.sku), blocked: setsBlocked(m) };
		};
		expect(sets(blade)).toEqual({ in: ["OTHER", "SET"], blocked: 2 });
		expect(sets(knife)).toEqual({ in: ["SET"], blocked: 0 });
		expect(sets(loner)).toEqual({ in: [], blocked: 0 });
		expect(of(blade)?.why).toMatchObject({ minStock: 3, minFrom: "sets" });

		const [s] = await suggestPurchases(db, now);
		// Topped up to one of the set that takes most: 3, less the 1 there.
		// Essential too, so it counts toward the essential threshold.
		expect(s.lines.map((l) => [l.sku, l.quantity, l.critical])).toEqual([
			["BLADE", 2, true],
		]);
		expect(s.critical).toBe(1);
		const r = await recommendedAdditions(
			db,
			canam,
			new Set(),
			DEFAULT_SETTINGS,
			now,
		);
		expect(r.map((l) => l.sku)).toEqual(["LONER"]);
	});
});
