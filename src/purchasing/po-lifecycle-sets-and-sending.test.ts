import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { createProduct } from "#/test/db";
import {
	addDraftLine,
	addSetToOtherDrafts,
	draftFromSuggestions,
	markSent,
	openDraft,
	purchaseOrderOfBatch,
	receive,
	removeAddedLine,
	setDraftLine,
	setPartsOf,
	skipSetPart,
	undoReceipt,
	updateFromSuggestions,
} from "./orders";
import {
	carry,
	createPurchasingDb,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";
import { partState } from "./sets";
import { setLineTerms } from "./units";

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

	test("a tool set is its own line until sent, then becomes its parts", async () => {
		const handle = await createProduct(db, "HANDLE", "simple");
		await db
			.update(schema.products)
			.set({ unitCost: 3 })
			.where(eq(schema.products.id, handle));
		// No price from Canam, so the line has none: our cost isn't theirs.
		await carry(db, handle, canam);
		await db
			.insert(schema.productSuppliers)
			.values({ productId: handle, supplierId: canam, supplierCount: 1 });
		// At its min stock, so it isn't suggested by itself.
		await stock(handle, 1);
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [
			{ productId: blade, quantity: 2 },
			{ productId: handle, quantity: 1 },
		]);
		const id = await draftFromSuggestions(db, canam, now);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 3,
		});
		expect((await linesOf(id)).map((l) => l.productId)).toEqual([
			blade,
			knife,
			set,
		]);

		await markSent(db, {
			purchaseOrderId: id,
			now,
			deliver: async (tx) => {
				// The supplier is sent the parts, not the set.
				const lines = await tx
					.select()
					.from(schema.purchaseOrderLines)
					.where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
				expect(lines.map((l) => l.productId)).not.toContain(set);
				return "orders@canam.example";
			},
		});
		expect(await linesOf(id)).toMatchObject([
			// 110 suggested (120 sold, 10 on the shelf) plus 2 in each of 3 sets.
			{ productId: blade, quantity: 116 },
			// 9 sold, over the supplier's minimum of 6.
			{ productId: knife, quantity: 9 },
			// Not on the draft before: a new line, with no price yet.
			{ productId: handle, quantity: 3, unit: "EACH", unitCost: null },
		]);
	});

	test("a set orders only its parts bought from the PO's supplier", async () => {
		const [{ id: other }] = await db
			.insert(schema.suppliers)
			.values({ code: "OTHER", name: "Other", leadTimeDays: 5 })
			.returning();
		const handle = await createProduct(db, "HANDLE", "simple");
		await carry(db, handle, other);
		await db.insert(schema.productSuppliers).values({
			productId: handle,
			supplierId: other,
			supplierCount: 1,
			cost: 1,
		});
		const loose = await createProduct(db, "LOOSE", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [
			{ productId: blade, quantity: 2 },
			{ productId: handle, quantity: 1 },
			{ productId: loose, quantity: 1 },
		]);
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 3,
		});
		const parts = await setPartsOf(db, id);
		expect(parts.map((p) => [p.sku, partState(p, 3, canam)])).toEqual([
			["BLADE", { kind: "here" }],
			["HANDLE", { kind: "short", covered: 0, noSupplier: false }],
			["LOOSE", { kind: "short", covered: 0, noSupplier: true }],
		]);

		await markSent(db, { purchaseOrderId: id, sentTo: null });
		expect(await linesOf(id)).toMatchObject([
			{ productId: blade, quantity: 6 },
		]);
	});

	test("a set goes on its other suppliers' drafts, counting what's sent", async () => {
		const [{ id: other }] = await db
			.insert(schema.suppliers)
			.values({ code: "OTHER", name: "Other", leadTimeDays: 5 })
			.returning();
		const handle = await createProduct(db, "HANDLE", "simple");
		await carry(db, handle, other);
		await db.insert(schema.productSuppliers).values({
			productId: handle,
			supplierId: other,
			supplierCount: 1,
			cost: 1,
		});
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [
			{ productId: blade, quantity: 2 },
			{ productId: handle, quantity: 1 },
		]);
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 3,
		});
		const [setLine] = await linesOf(id);
		const handleState = async () => {
			const p = (await setPartsOf(db, id)).find((p) => p.sku === "HANDLE");
			const [line] = await linesOf(id);
			return p && partState(p, line.quantity, canam);
		};

		const [added] = await addSetToOtherDrafts(db, { lineId: setLine.id });
		expect(added).toMatchObject({ supplierName: "Other", sets: 3 });
		const to = added.purchaseOrderId;
		expect(await linesOf(to)).toMatchObject([{ productId: set, quantity: 3 }]);
		expect(await handleState()).toEqual({ kind: "covered", covered: 3 });

		// Only Other's PO orders the handle, so only there can it be skipped.
		await expect(
			skipSetPart(db, { lineId: setLine.id, productId: handle, skipped: true }),
		).rejects.toThrow(/bought from Other; skip it on their PO/);

		// Skipped on their draft, it's missing here again; adding orders it
		// there again without adding more sets.
		const [theirLine] = await linesOf(to);
		await skipSetPart(db, {
			lineId: theirLine.id,
			productId: handle,
			skipped: true,
		});
		expect(await handleState()).toEqual({
			kind: "short",
			covered: 0,
			noSupplier: false,
		});
		expect(await addSetToOtherDrafts(db, { lineId: setLine.id })).toEqual([
			{ purchaseOrderId: to, supplierName: "Other", sets: 3 },
		]);
		expect(await handleState()).toEqual({ kind: "covered", covered: 3 });

		// More sets here raise theirs to match, not by as many again.
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 5,
		});
		expect(await handleState()).toMatchObject({ kind: "short", covered: 3 });
		await addSetToOtherDrafts(db, { lineId: setLine.id });
		expect(await linesOf(to)).toMatchObject([{ productId: set, quantity: 5 }]);

		// Once theirs is sent, its sets still count.
		await markSent(db, { purchaseOrderId: to, sentTo: null });
		expect(await linesOf(to)).toMatchObject([
			{ productId: handle, quantity: 5 },
		]);
		expect(await handleState()).toEqual({ kind: "covered", covered: 5 });
		await expect(
			addSetToOtherDrafts(db, { lineId: setLine.id }),
		).rejects.toThrow(/already on order/);
	});

	test("a set has no price of its own, and a skipped part stays skipped", async () => {
		const set = await createProduct(db, "SET", "bundle");
		await db
			.update(schema.products)
			.set({ unitCost: 50 })
			.where(eq(schema.products.id, set));
		await setRecipe(db, set, [
			{ productId: blade, quantity: 2 },
			{ productId: knife, quantity: 1 },
		]);
		const id = await openDraft(db, canam);
		await expect(
			setDraftLine(db, {
				purchaseOrderId: id,
				productId: set,
				quantity: 1,
				unitCost: 100,
			}),
		).rejects.toThrow(/priced as its parts/);
		const { line } = await addDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 1,
		});
		expect(line.unitCost).toBeNull();

		await skipSetPart(db, {
			lineId: line.id,
			productId: knife,
			skipped: true,
		});
		await expect(
			skipSetPart(db, { lineId: line.id, productId: set, skipped: true }),
		).rejects.toThrow(/isn't part of SET/);
		// Skipping a part changed the set, so undoing the add leaves it.
		expect(await removeAddedLine(db, { purchaseOrderId: id, line })).toBe(
			false,
		);

		// Taking the set off and putting it back (Undo) keeps the part skipped.
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 0,
		});
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 2,
			unitCost: null,
		});
		const [setLine] = await linesOf(id);
		expect((await setPartsOf(db, id)).map((p) => [p.sku, p.skipped])).toEqual([
			["BLADE", false],
			["KNIFE", true],
		]);
		await skipSetPart(db, {
			lineId: setLine.id,
			productId: blade,
			skipped: true,
		});
		await skipSetPart(db, {
			lineId: setLine.id,
			productId: knife,
			skipped: false,
		});
		await markSent(db, { purchaseOrderId: id, sentTo: null });
		expect(await linesOf(id)).toMatchObject([
			{ productId: knife, quantity: 2 },
		]);
	});

	test("a set's part adds onto a line in cases, rounded up", async () => {
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: knife, quantity: 1 }]);
		const id = await draftFromSuggestions(db, canam, now);
		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: knife,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			minimumQuantity: 1,
			makeDefault: false,
		});
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 3,
		});
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 3,
		});
		expect(
			(await setPartsOf(db, id)).map((p) => [p.perSet, p.unit, p.packSize]),
		).toEqual([[1, "CASE", 12]]);

		await markSent(db, { purchaseOrderId: id, sentTo: null });
		const knifeLine = (await linesOf(id)).find((l) => l.productId === knife);
		expect(knifeLine).toMatchObject({ unit: "CASE", quantity: 4 });
	});

	test("suggestions count parts already coming in a set", async () => {
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [
			{ productId: blade, quantity: 2 },
			{ productId: knife, quantity: 1 },
		]);
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 4,
		});
		// 8 blades and 4 knives in the sets: 102 more blades (110 suggested),
		// and 5 knives (9 suggested) rounded up to the supplier's 6.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 2,
			raised: 0,
		});
		expect(await linesOf(id)).toMatchObject([
			{ productId: blade, quantity: 102 },
			{ productId: knife, quantity: 6 },
			{ productId: set, quantity: 4 },
		]);

		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: set,
			quantity: 20,
		});
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 0,
		});
	});

	test("refuses a set with no parts, and empty POs", async () => {
		const set = await createProduct(db, "SET", "bundle");
		const id = await draftFromSuggestions(db, canam, now);
		await expect(
			setDraftLine(db, { purchaseOrderId: id, productId: set, quantity: 1 }),
		).rejects.toThrow(/has no parts/);
		await expect(
			addDraftLine(db, { purchaseOrderId: id, productId: set, quantity: 1 }),
		).rejects.toThrow(/has no parts/);

		for (const l of await linesOf(id))
			await setDraftLine(db, {
				purchaseOrderId: id,
				productId: l.productId,
				quantity: 0,
			});
		await expect(
			markSent(db, { purchaseOrderId: id, sentTo: null }),
		).rejects.toThrow(/nothing on it/);
	});

	test("stays a draft when delivering it fails", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await expect(
			markSent(db, {
				purchaseOrderId: id,
				sentTo: "a@b.c",
				deliver: async () => {
					throw new Error("email down");
				},
			}),
		).rejects.toThrow("email down");
		expect((await getPo(id)).status).toBe("draft");
	});

	test("sends what's on the PO at the moment it's locked", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		const sentTo = await markSent(db, {
			purchaseOrderId: id,
			now,
			// deliver reads through the locked transaction it's given.
			deliver: async (tx) => {
				const lines = await tx
					.select()
					.from(schema.purchaseOrderLines)
					.where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
				expect(lines).toHaveLength(2);
				return "orders@canam.example";
			},
		});
		expect(sentTo).toBe("orders@canam.example");
		expect((await getPo(id)).sentTo).toBe("orders@canam.example");
	});

	test("knows which PO a receipt's ledger batch belongs to", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await markSent(db, { purchaseOrderId: id, sentTo: null, now });
		const [line] = await linesOf(id);
		const { receiptId } = await receive(db, {
			key: crypto.randomUUID(),
			lineId: line.id,
			quantity: 1,
		});
		const [receipt] = await db
			.select()
			.from(schema.purchaseOrderReceipts)
			.where(eq(schema.purchaseOrderReceipts.id, receiptId));
		expect(await purchaseOrderOfBatch(db, receipt.batchId)).toBe(id);

		await undoReceipt(db, receiptId);
		const [undo] = await db
			.select()
			.from(schema.purchaseOrderReceipts)
			.where(eq(schema.purchaseOrderReceipts.undoesId, receiptId));
		expect(await purchaseOrderOfBatch(db, undo.batchId)).toBe(id);

		const { batchId } = await postMovements(db, {
			lines: [
				{
					productId: blade,
					locationId: warehouse,
					delta: 1,
					reason: "adjustment",
				},
			],
		});
		expect(await purchaseOrderOfBatch(db, batchId)).toBeNull();
	});
});
