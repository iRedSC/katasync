import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { setRecipe } from "#/inventory/recipes";
import { createProduct } from "#/test/db";
import { loadOrder, printedLines } from "./load";
import {
	addLine,
	amendLine,
	cancelOrder,
	closeOrder,
	deleteDraft,
	draftFromSuggestions,
	markSent,
	openDraft,
	openSuggested,
	orderAgain,
	receive,
	receiveExtra,
	refreshSuggested,
	restoreDraft,
	setDraftLine,
	undoReceipt,
} from "./orders";
import {
	createPurchasingDb,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";
import { readyToOrder, suggestPurchases } from "./reorder";

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

	test("ordering again copies what was sent onto the draft, never twice", async () => {
		const { id, bladeLine } = await sent();
		await receive(db, { lineId: bladeLine.id, quantity: 10, last: true });
		await closeOrder(db, id);
		const r = await orderAgain(db, id);
		// The blade line was cut to the 10 that came; what was sent was 44.
		expect((await linesOf(r.id)).map((l) => l.quantity)).toEqual([44, 6]);
		expect(await orderAgain(db, id)).toEqual({
			id: r.id,
			added: 0,
			alreadyOn: 2,
			moved: 0,
		});
		await expect(orderAgain(db, r.id)).rejects.toThrow(/is draft/);
	});

	test("ordering again leaves off products bought elsewhere now", async () => {
		const { id } = await sent();
		await cancelOrder(db, id);
		const [{ id: other }] = await db
			.insert(schema.suppliers)
			.values({ code: "OTHER", name: "Other", leadTimeDays: 5, coverDays: 10 })
			.returning();
		await db
			.update(schema.productSuppliers)
			.set({ supplierId: other })
			.where(eq(schema.productSuppliers.productId, knife));
		const r = await orderAgain(db, id);
		expect(r).toMatchObject({ added: 1, alreadyOn: 0, moved: 1 });
		expect((await linesOf(r.id)).map((l) => l.productId)).toEqual([blade]);

		await db
			.update(schema.productSuppliers)
			.set({ supplierId: other })
			.where(eq(schema.productSuppliers.productId, blade));
		await deleteDraft(db, r.id);
		await expect(orderAgain(db, id)).rejects.toThrow(/still bought/);
		expect(
			await db
				.select()
				.from(schema.purchaseOrders)
				.where(eq(schema.purchaseOrders.status, "draft")),
		).toHaveLength(0);
	});

	test("a ready supplier leaves Ready to order once it has a draft, and returns when the draft is deleted", async () => {
		expect(readyToOrder(await suggestPurchases(db, now))).toHaveLength(1);
		const id = await draftFromSuggestions(db, canam, now);
		const suggestions = await suggestPurchases(db, now);
		expect(suggestions[0]).toMatchObject({ draftId: id });
		expect(readyToOrder(suggestions)).toEqual([]);
		await deleteDraft(db, id);
		expect(readyToOrder(await suggestPurchases(db, now))).toHaveLength(1);
	});

	test("a suggestion opens as a suggested PO, and its first change makes it a draft", async () => {
		const id = await openSuggested(db, canam, now);
		expect((await getPo(id)).status).toBe("suggested");
		const [suggestion] = await suggestPurchases(db, now);
		expect((await linesOf(id)).map((l) => [l.productId, l.quantity])).toEqual(
			suggestion.lines
				.map((l) => [l.productId, l.quantity])
				.sort((a, b) => a[0] - b[0]),
		);
		// Only a look: still ready to order, and opening it again is the same PO.
		expect(readyToOrder(await suggestPurchases(db, now))).toHaveLength(1);
		expect(await openSuggested(db, canam, now)).toBe(id);

		const [line] = await linesOf(id);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: line.productId,
			quantity: line.quantity + 1,
		});
		expect((await getPo(id)).status).toBe("draft");
		expect(readyToOrder(await suggestPurchases(db, now))).toEqual([]);
		// Now a draft, it no longer follows the suggestion.
		await refreshSuggested(db, id, now);
		expect((await linesOf(id))[0].quantity).toBe(line.quantity + 1);
	});

	test("a suggested PO follows the suggestion, keeping its lines' ids", async () => {
		const id = await openSuggested(db, canam, now);
		const before = await linesOf(id);
		await db
			.update(schema.purchaseOrderLines)
			.set({ quantity: 999 })
			.where(eq(schema.purchaseOrderLines.id, before[0].id));
		await refreshSuggested(db, id, now);
		expect(await linesOf(id)).toEqual(before);
	});

	test("bringing back a deleted draft replaces the supplier's suggested PO", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		const lines = await linesOf(id);
		const deleted = await deleteDraft(db, id);
		const suggested = await openSuggested(db, canam, now);
		await restoreDraft(db, deleted);
		expect((await getPo(id)).status).toBe("draft");
		expect(await linesOf(id)).toHaveLength(lines.length);
		expect(await getPo(suggested)).toBeUndefined();
	});

	test("starting a draft for a supplier with a suggested PO starts it empty", async () => {
		const id = await openSuggested(db, canam, now);
		expect(await openDraft(db, canam)).toBe(id);
		expect((await getPo(id)).status).toBe("draft");
		expect(await linesOf(id)).toEqual([]);
	});

	test("can't receive a draft; deleting a draft removes it and frees the slot", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		const [line] = await linesOf(id);
		await expect(receive(db, { lineId: line.id, quantity: 1 })).rejects.toThrow(
			/is draft/,
		);
		await deleteDraft(db, id);
		expect(await linesOf(id)).toEqual([]);
		expect(await getPo(id)).toBeUndefined();
		expect(await draftFromSuggestions(db, canam, now)).not.toBe(id);
	});

	// Draft from suggestions: 44 blades at $5, 6 knives at $2.
	async function sent() {
		const id = await draftFromSuggestions(db, canam, now);
		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		const [bladeLine, knifeLine] = await linesOf(id);
		return { id, bladeLine, knifeLine };
	}

	test("sending saves what was sent; changes after it never print", async () => {
		const { id, bladeLine, knifeLine } = await sent();
		expect(bladeLine).toMatchObject({ sentQuantity: 44, sentUnitCost: 5 });

		await amendLine(db, { lineId: bladeLine.id, quantity: 47, unitCost: 6 });
		await amendLine(db, { lineId: knifeLine.id, quantity: 0 });
		const gauge = await createProduct(db, "GAUGE", "simple");
		await addLine(db, { purchaseOrderId: id, productId: gauge, quantity: 3 });

		const po = await loadOrder(db, id);
		expect(
			printedLines(po.lines, po.order.sentAt).map((l) => [
				l.sku,
				l.quantity,
				l.unitCost,
			]),
		).toEqual([
			["BLADE", 44, 5],
			["KNIFE", 6, 2],
		]);
		// A draft prints as it stands.
		const draft = await openDraft(db, canam);
		await addLine(db, {
			purchaseOrderId: draft,
			productId: gauge,
			quantity: 2,
		});
		const d = await loadOrder(db, draft);
		expect(printedLines(d.lines, d.order.sentAt)).toMatchObject([
			{ sku: "GAUGE", quantity: 2 },
		]);
	});

	test("more than expected arrives: the line expects it, and undo puts it back", async () => {
		const { id, bladeLine } = await sent();
		const r = await receive(db, { lineId: bladeLine.id, quantity: 47 });
		expect((await linesOf(id))[0]).toMatchObject({
			quantity: 47,
			sentQuantity: 44,
		});
		await undoReceipt(db, r.receiptId);
		expect((await linesOf(id))[0].quantity).toBe(44);
	});

	test("marking the last of a line expects only what came, and closes the PO", async () => {
		const { id, bladeLine, knifeLine } = await sent();
		await receive(db, { lineId: knifeLine.id, quantity: 6 });
		await receive(db, { lineId: bladeLine.id, quantity: 20 });
		const r = await receive(db, {
			lineId: bladeLine.id,
			quantity: 10,
			last: true,
		});
		expect(r.closed).toBe(true);
		expect((await linesOf(id))[0].quantity).toBe(30);
		// Undoing it waits for the rest again.
		await undoReceipt(db, r.receiptId);
		expect((await linesOf(id))[0].quantity).toBe(44);
		expect((await getPo(id)).status).toBe("sent");
	});

	test("undo leaves a quantity someone changed since", async () => {
		const { id, bladeLine } = await sent();
		const r = await receive(db, { lineId: bladeLine.id, quantity: 47 });
		await amendLine(db, { lineId: bladeLine.id, quantity: 52 });
		await undoReceipt(db, r.receiptId);
		expect((await linesOf(id))[0].quantity).toBe(52);
	});

	test("amending can't go under what arrived; settles the PO either way", async () => {
		const { id, bladeLine, knifeLine } = await sent();
		await receive(db, { lineId: bladeLine.id, quantity: 44 });
		await receive(db, { lineId: knifeLine.id, quantity: 2 });
		await expect(
			amendLine(db, { lineId: knifeLine.id, quantity: 1 }),
		).rejects.toThrow(/2 already arrived/);
		// The supplier only had 2: that's everything, so it closes.
		const r = await amendLine(db, { lineId: knifeLine.id, quantity: 2 });
		expect(r.was).toEqual({ quantity: 6, unitCost: 2 });
		expect((await getPo(id)).status).toBe("closed");
		// Back to 6 waits for the rest again.
		await amendLine(db, { lineId: knifeLine.id, quantity: 6 });
		expect((await getPo(id)).status).toBe("sent");
	});

	test("a price change after stock arrived says that stock kept the old cost", async () => {
		const { bladeLine, knifeLine } = await sent();
		await receive(db, { lineId: bladeLine.id, quantity: 1 });
		expect(
			(await amendLine(db, { lineId: bladeLine.id, unitCost: 6 }))
				.receivedAtOldCost,
		).toBe(true);
		expect(
			(await amendLine(db, { lineId: knifeLine.id, unitCost: 3 }))
				.receivedAtOldCost,
		).toBe(false);
	});

	test("a line added after sending comes off at 0; a sent one stays at 0", async () => {
		const { id, knifeLine } = await sent();
		const gauge = await createProduct(db, "GAUGE", "simple");
		const { line } = await addLine(db, {
			purchaseOrderId: id,
			productId: gauge,
			quantity: 3,
		});
		expect(
			(await amendLine(db, { lineId: line.id, quantity: 0 })).removed,
		).toBe(true);
		expect(
			(await amendLine(db, { lineId: knifeLine.id, quantity: 0 })).removed,
		).toBe(false);
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([44, 0]);
	});

	test("something extra in the box is added and received, even on a closed PO", async () => {
		const { id, bladeLine, knifeLine } = await sent();
		await receive(db, { lineId: bladeLine.id, quantity: 44 });
		await receive(db, { lineId: knifeLine.id, quantity: 6 });
		expect((await getPo(id)).status).toBe("closed");

		const gauge = await createProduct(db, "GAUGE", "simple");
		const r = await receiveExtra(db, {
			purchaseOrderId: id,
			productId: gauge,
			quantity: 4,
		});
		expect(r.closed).toBe(true);
		const extra = (await linesOf(id)).find((l) => l.productId === gauge);
		expect(extra).toMatchObject({ quantity: 4, sentQuantity: null });

		// Undoing it expects nothing of it, so the PO stays closed.
		await undoReceipt(db, r.receiptId);
		expect(
			(await linesOf(id)).find((l) => l.productId === gauge)?.quantity,
		).toBe(0);
		expect((await getPo(id)).status).toBe("closed");
	});

	test("changes after sending go on the timeline; receipts keep their own", async () => {
		const { id, bladeLine, knifeLine } = await sent();
		await amendLine(db, { lineId: bladeLine.id, quantity: 47, unitCost: 6 });
		// No change, no entry.
		await amendLine(db, { lineId: knifeLine.id, quantity: 6 });
		const gauge = await createProduct(db, "GAUGE", "simple");
		const { line } = await addLine(db, {
			purchaseOrderId: id,
			productId: gauge,
			quantity: 3,
		});
		await amendLine(db, { lineId: line.id, quantity: 0 });
		// Extra in the box is on its receipt, not here.
		const nut = await createProduct(db, "NUT", "simple");
		await receiveExtra(db, {
			purchaseOrderId: id,
			productId: nut,
			quantity: 2,
		});
		// Nothing on a draft is a change.
		const draft = await openDraft(db, canam);
		await addLine(db, {
			purchaseOrderId: draft,
			productId: gauge,
			quantity: 1,
		});

		const log = await db
			.select()
			.from(schema.purchaseOrderAmendments)
			.orderBy(schema.purchaseOrderAmendments.id);
		expect(
			log.map((a) => [
				a.purchaseOrderId,
				a.kind,
				a.quantityBefore,
				a.quantityAfter,
				a.unitCostBefore,
				a.unitCostAfter,
			]),
		).toEqual([
			[id, "quantity", 44, 47, null, null],
			[id, "cost", null, null, 5, 6],
			[id, "added", null, 3, null, null],
			[id, "removed", 3, null, null, null],
		]);
		const [receipt] = await db
			.select()
			.from(schema.purchaseOrderReceipts)
			.innerJoin(
				schema.purchaseOrderLines,
				eq(schema.purchaseOrderLines.id, schema.purchaseOrderReceipts.lineId),
			)
			.where(eq(schema.purchaseOrderLines.productId, nut));
		expect(receipt.purchase_order_receipts).toMatchObject({
			quantityBefore: 0,
			quantityAfter: 2,
		});
	});

	test("adding a product already on the PO leaves its line alone", async () => {
		const { id, bladeLine } = await sent();
		const r = await addLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 1,
		});
		expect(r).toMatchObject({
			added: false,
			line: { id: bladeLine.id, quantity: 44 },
		});
	});

	test("a tool set can't be added once sent", async () => {
		const { id } = await sent();
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: blade, quantity: 2 }]);
		await expect(
			addLine(db, { purchaseOrderId: id, productId: set, quantity: 1 }),
		).rejects.toThrow(/tool set/);
	});
});
