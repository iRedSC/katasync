import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import { supplierRows } from "./load";
import {
	cancelOrder,
	closeOrder,
	deleteDraft,
	draftFromSuggestions,
	markSent,
	openDraft,
	receive,
	restoreDraft,
	restoreOrder,
	undoReceipt,
} from "./orders";
import {
	createPurchasingDb,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";
import { suggestPurchases, unitsOnOrder } from "./reorder";

let db: Db;
let warehouse: number;
let canam: number;
let store: number;
const { stock, sell, supply, getPo, linesOf } = purchasingBuilders(() => ({
	db,
	warehouse,
	canam,
	store,
}));

beforeEach(async () => {
	({ db, warehouse, canam, store } = await createPurchasingDb());
});

describe("a PO from draft to received", () => {
	let blade: number;
	let knife: number;

	beforeEach(async () => {
		blade = await createProduct(db, "BLADE", "simple");
		knife = await createProduct(db, "KNIFE", "simple");
		await supply(blade, 5);
		await supply(knife, 2, 6);
		await db
			.update(schema.products)
			.set({ unitCost: 4 })
			.where(eq(schema.products.id, blade));
		await stock(blade, 10);
		await sell(blade, 120);
		await sell(knife, 9);
	});

	test("counts each supplier's products and POs on order", async () => {
		// A second supplier, so ids differ from the PO's and a wrong join shows.
		await db.insert(schema.suppliers).values({ code: "AAA", name: "Aardvark" });
		const id = await draftFromSuggestions(db, canam, now);
		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		const rows = await supplierRows(db);
		expect(
			rows.map((r) => [r.supplier.code, r.products, r.openOrders]),
		).toEqual([
			["AAA", 0, 0],
			["CANAM", 2, 1],
		]);
	});

	test("receives in parts, averages cost, closes when complete, undoes", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await markSent(db, { purchaseOrderId: id, sentTo: "a@b.c", now });
		expect(await getPo(id)).toMatchObject({
			status: "sent",
			expectedAt: new Date("2026-10-20T12:00:00Z"),
		});
		expect((await unitsOnOrder(db)).get(blade)).toBe(44);
		// On order now, so nothing more is suggested.
		expect(await suggestPurchases(db, now)).toEqual([]);

		const [bladeLine, knifeLine] = await linesOf(id);
		await receive(db, { lineId: bladeLine.id, quantity: 10 });
		expect((await unitsOnOrder(db)).get(blade)).toBe(34);
		const [product] = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, blade));
		// 10 on the shelf at $4, 10 more at $5.
		expect(product.unitCost).toBe(4.5);

		const last = await receive(db, { lineId: bladeLine.id, quantity: 34 });
		expect(last.closed).toBe(false);
		const knives = await receive(db, { lineId: knifeLine.id, quantity: 6 });
		expect(knives.closed).toBe(true);
		expect((await getPo(id)).status).toBe("closed");

		await undoReceipt(db, knives.receiptId);
		expect((await getPo(id)).status).toBe("sent");
		await expect(undoReceipt(db, knives.receiptId)).rejects.toThrow(
			/Already undone/,
		);
		const [level] = await db
			.select()
			.from(schema.stockLevels)
			.where(eq(schema.stockLevels.productId, knife));
		expect(level.onHand).toBe(0);

		await expect(cancelOrder(db, id)).rejects.toThrow(/close it instead/);
		await closeOrder(db, id);
		expect((await getPo(id)).status).toBe("closed");
		await expect(
			receive(db, { lineId: knifeLine.id, quantity: 1 }),
		).rejects.toThrow(/is closed/);
	});

	test("receiving onto oversold stock restarts it from 0, and undo puts it back", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		const knifeLine = (await linesOf(id))[1];
		await stock(knife, -4);
		const shelf = async () =>
			(
				await db
					.select()
					.from(schema.stockLevels)
					.where(eq(schema.stockLevels.productId, knife))
			)[0].onHand;

		const { receiptId } = await receive(db, {
			lineId: knifeLine.id,
			quantity: 6,
		});
		expect(await shelf()).toBe(6);
		const written = await db
			.select({ delta: schema.movements.delta })
			.from(schema.movements)
			.where(eq(schema.movements.reason, "oversold_reset"));
		expect(written).toEqual([{ delta: 4 }]);

		await undoReceipt(db, receiptId);
		expect(await shelf()).toBe(-4);
	});

	test("drafts are deleted, not cancelled; sent POs are cancelled, not deleted", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await expect(cancelOrder(db, id, now)).rejects.toThrow(/is draft/);
		await markSent(db, { purchaseOrderId: id, sentTo: null });
		await expect(deleteDraft(db, id)).rejects.toThrow(/is sent/);
		expect((await getPo(id)).status).toBe("sent");
		await cancelOrder(db, id);
		expect((await getPo(id)).status).toBe("cancelled");
	});

	test("undoing a cancel puts a sent PO back on order", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		await cancelOrder(db, id);
		await restoreOrder(db, id);
		expect(await getPo(id)).toMatchObject({ status: "sent", closedAt: null });
		await expect(restoreOrder(db, id)).rejects.toThrow(/is sent/);
	});

	test("undoing a delete brings the draft back under its number, lines and skipped parts too", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await db.insert(schema.purchaseOrderSkippedParts).values({
			purchaseOrderId: id,
			setProductId: blade,
			partProductId: knife,
		});
		const before = await linesOf(id);
		const deleted = await deleteDraft(db, id);
		expect(await getPo(id)).toBeUndefined();

		await restoreDraft(db, deleted);
		expect(await getPo(id)).toMatchObject({
			status: "draft",
			supplierId: canam,
		});
		expect(
			(await linesOf(id)).map(({ productId, quantity, unitCost }) => ({
				productId,
				quantity,
				unitCost,
			})),
		).toEqual(
			before.map(({ productId, quantity, unitCost }) => ({
				productId,
				quantity,
				unitCost,
			})),
		);
		expect(
			await db
				.select()
				.from(schema.purchaseOrderSkippedParts)
				.where(eq(schema.purchaseOrderSkippedParts.purchaseOrderId, id)),
		).toHaveLength(1);
		await expect(restoreDraft(db, deleted)).rejects.toThrow(/new draft/);
		// New POs still number on from where they were.
		await deleteDraft(db, id);
		expect(await openDraft(db, canam)).toBeGreaterThan(id);
	});

	test("a deleted draft can't come back over its supplier's new draft", async () => {
		const deleted = await deleteDraft(
			db,
			await draftFromSuggestions(db, canam, now),
		);
		const fresh = await openDraft(db, canam);
		await expect(restoreDraft(db, deleted)).rejects.toThrow(
			new RegExp(`new draft, PO ${fresh}`),
		);
	});
});
