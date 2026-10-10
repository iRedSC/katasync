import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import { supplierRows } from "./load";
import {
	averageCost,
	cancelOrder,
	closeOrder,
	draftFromSuggestions,
	markSent,
	openDraft,
	purchaseOrderOfBatch,
	receive,
	setDraftLine,
	undoReceipt,
	updateFromSuggestions,
} from "./orders";
import { reorderQuantity, suggestPurchases, unitsOnOrder } from "./reorder";
import {
	addUnit,
	deleteUnit,
	listUnits,
	renameUnit,
	setLineTerms,
	setPurchaseUnit,
} from "./units";

const now = new Date("2026-10-10T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe("reorderQuantity", () => {
	const base = {
		dailyDemand: 1,
		onHand: 0,
		onOrder: 0,
		leadTimeDays: 10,
		safetyDays: 0,
		coverDays: 20,
		minimumQuantity: 1,
		packSize: 1,
	};

	test("orders once stock won't last until a new PO arrives", () => {
		expect(reorderQuantity({ ...base, onHand: 10 })).toBe(0);
		expect(reorderQuantity({ ...base, onHand: 9 })).toBe(21);
	});

	test("counts what's already on order", () => {
		expect(reorderQuantity({ ...base, onHand: 4, onOrder: 6 })).toBe(0);
		expect(reorderQuantity({ ...base, onHand: 4, onOrder: 5 })).toBe(21);
	});

	test("rounds up to the supplier's minimum", () => {
		expect(reorderQuantity({ ...base, onHand: 9, minimumQuantity: 30 })).toBe(
			30,
		);
	});

	test("orders whole packs, with the minimum counted in packs", () => {
		// 21 needed: one case of 30 covers it.
		expect(reorderQuantity({ ...base, onHand: 9, packSize: 30 })).toBe(1);
		expect(reorderQuantity({ ...base, onHand: 9, packSize: 10 })).toBe(3);
		expect(
			reorderQuantity({ ...base, onHand: 9, packSize: 30, minimumQuantity: 2 }),
		).toBe(2);
	});

	test("buys back oversold stock even with no recent sales", () => {
		expect(reorderQuantity({ ...base, dailyDemand: 0, onHand: -2 })).toBe(2);
		expect(reorderQuantity({ ...base, dailyDemand: 0 })).toBe(0);
	});
});

test("averageCost weighs what's on the shelf against what arrived", () => {
	expect(
		averageCost({ oldCost: 10, onHandBefore: 10, quantity: 10, unitCost: 20 }),
	).toBe(15);
	expect(
		averageCost({ oldCost: 10, onHandBefore: -3, quantity: 5, unitCost: 20 }),
	).toBe(20);
	expect(
		averageCost({ oldCost: null, onHandBefore: 4, quantity: 5, unitCost: 7 }),
	).toBe(7);
});

let db: Db;
let warehouse: number;
let canam: number;
let store: number;

async function stock(productId: number, qty: number) {
	await postMovements(db, {
		lines: [
			{
				productId,
				locationId: warehouse,
				delta: qty,
				reason: "opening_balance",
			},
		],
	});
}

let orderCount = 0;
async function sell(
	productId: number,
	quantity: number,
	extra: Partial<typeof schema.orders.$inferInsert> = {},
) {
	const n = ++orderCount;
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store,
			externalId: `o${n}`,
			name: `#${n}`,
			placedAt: daysAgo(10),
			fulfillmentStatus: "FULFILLED",
			total: 1,
			sourceUpdatedAt: now,
			...extra,
		})
		.returning();
	await db.insert(schema.orderLines).values({
		orderId: order.id,
		externalId: `l${n}`,
		productId,
		title: "x",
		quantity,
		unitPrice: 1,
	});
}

async function supply(productId: number, cost: number | null, minimum = 1) {
	await db.insert(schema.productSuppliers).values({
		productId,
		supplierId: canam,
		cost,
		minimumQuantity: minimum,
	});
}

async function getPo(id: number) {
	const [po] = await db
		.select()
		.from(schema.purchaseOrders)
		.where(eq(schema.purchaseOrders.id, id));
	return po;
}

async function linesOf(id: number) {
	return db
		.select()
		.from(schema.purchaseOrderLines)
		.where(eq(schema.purchaseOrderLines.purchaseOrderId, id))
		.orderBy(schema.purchaseOrderLines.productId);
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	[{ id: canam }] = await db
		.insert(schema.suppliers)
		.values({
			code: "CANAM",
			name: "CanAm",
			leadTimeDays: 10,
			coverDays: 20,
			minimumOrder: 100,
		})
		.returning();
	[{ id: store }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shop" })
		.returning();
});

describe("suggestPurchases", () => {
	test("counts tool sets as their parts and skips FBA and cancelled orders", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: blade, quantity: 2 }]);
		await supply(blade, 5);

		await sell(blade, 30);
		await sell(set, 15); // 30 blades
		await sell(blade, 900, { fulfilledByChannel: true });
		await sell(blade, 900, { cancelledAt: now });
		await sell(blade, 900, { placedAt: daysAgo(91) });

		const [s] = await suggestPurchases(db, now);
		// 60 sold over 90 days, for 10 + 20 days plus 5 spare as an A item: 24.
		expect(s.lines).toMatchObject([{ sku: "BLADE", sold: 60, quantity: 24 }]);
		expect(s).toMatchObject({ total: 120, ready: true, draftId: null });
	});

	test("isn't ready below the supplier's minimum, and lists unpriced lines", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await supply(blade, 1);
		await supply(knife, null);
		await stock(knife, -1);
		await sell(blade, 90);

		const [s] = await suggestPurchases(db, now);
		expect(s.lines.map((l) => l.sku)).toEqual(["BLADE", "KNIFE"]);
		// Blade is an A item: 1 a day for 10 + 20 days plus 5 spare.
		expect(s).toMatchObject({ total: 35, unpriced: 1, ready: false });
	});
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

	test("drafts from suggestions without overwriting edits", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		expect(await linesOf(id)).toMatchObject([
			// 4 every 3 days for 10 + 20 days plus 5 spare (an A item), less
			// the 10 on hand.
			{ productId: blade, quantity: 37, unitCost: 5 },
			// 3 needed, but the supplier sells at least 6.
			{ productId: knife, quantity: 6, unitCost: 2 },
		]);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 40,
		});
		expect(await draftFromSuggestions(db, canam, now)).toBe(id);
		expect((await linesOf(id))[0].quantity).toBe(40);

		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 0,
		});
		expect(await linesOf(id)).toHaveLength(1);
	});

	test("a frozen draft updates on request: adds new, raises short, never lowers", async () => {
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 2,
		});
		// Blade (suggested 37) is short of what's suggested; the knife is new.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 1,
			raised: 1,
		});
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([37, 6]);
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 0,
		});

		// More than suggested stays as set.
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 50,
		});
		await updateFromSuggestions(db, id, now);
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([37, 50]);

		await markSent(db, { purchaseOrderId: id, sentTo: null });
		await expect(updateFromSuggestions(db, id, now)).rejects.toThrow(/is sent/);
	});

	test("refuses tool sets and empty POs", async () => {
		const set = await createProduct(db, "SET", "bundle");
		const id = await draftFromSuggestions(db, canam, now);
		await expect(
			setDraftLine(db, { purchaseOrderId: id, productId: set, quantity: 1 }),
		).rejects.toThrow(/order its parts/);

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
		const { receiptId } = await receive(db, { lineId: line.id, quantity: 1 });
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
		expect((await unitsOnOrder(db)).get(blade)).toBe(37);
		// On order now, so nothing more is suggested.
		expect(await suggestPurchases(db, now)).toEqual([]);

		const [bladeLine, knifeLine] = await linesOf(id);
		await receive(db, { lineId: bladeLine.id, quantity: 10 });
		expect((await unitsOnOrder(db)).get(blade)).toBe(27);
		const [product] = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, blade));
		// 10 on the shelf at $4, 10 more at $5.
		expect(product.unitCost).toBe(4.5);

		const last = await receive(db, { lineId: bladeLine.id, quantity: 27 });
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

	test("a draft-only cancel is checked under the lock, so a sent PO stays sent", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await markSent(db, { purchaseOrderId: id, sentTo: null });
		await expect(cancelOrder(db, id, now, ["draft"])).rejects.toThrow(
			/is sent/,
		);
		expect((await getPo(id)).status).toBe("sent");
		await cancelOrder(db, id);
		expect((await getPo(id)).status).toBe("cancelled");
	});

	test("can't receive a draft; a cancelled draft frees the slot", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		const [line] = await linesOf(id);
		await expect(receive(db, { lineId: line.id, quantity: 1 })).rejects.toThrow(
			/is draft/,
		);
		await cancelOrder(db, id);
		expect(await draftFromSuggestions(db, canam, now)).not.toBe(id);
	});
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
		// 120 sold in 90 days for 10 + 20 days plus 5 spare (an A item), 10 on
		// hand: 37 each to order.
		expect(await linesOf(id)).toMatchObject([
			{ unit: "EACH", packSize: 1, quantity: 37, unitCost: 2 },
		]);
		await setPurchaseUnit(db, {
			productId: blade,
			unit: "CASE",
			packSize: 12,
			minimumQuantity: 1,
		});
		// 37 blades round up to 4 cases of 12, at 12 × $2.
		expect(await linesOf(id)).toMatchObject([
			{ unit: "CASE", packSize: 12, quantity: 4, unitCost: 24 },
		]);
		const [link] = await db.select().from(schema.productSuppliers);
		expect(link).toMatchObject({ unit: "CASE", packSize: 12, cost: 24 });
		// The draft already has enough, so nothing more is suggested.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 0,
		});
	});

	test("receiving a case puts its contents on the shelf at the per-unit cost", async () => {
		await setPurchaseUnit(db, {
			productId: blade,
			unit: "CASE",
			packSize: 12,
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
			unit: "EACH",
			packSize: 1,
			minimumQuantity: 1,
		});
		expect((await linesOf(id))[0]).toMatchObject({ unit: "CASE", quantity: 3 });
	});

	test("terms set on one PO stay on that PO unless made the default", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		const terms = { unit: "CASE", packSize: 12, minimumQuantity: 2 };
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
		expect(link).toMatchObject({ unit: "EACH", packSize: 1, cost: 2 });
		// 37 wanted is 4 cases: already enough, though the units differ.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 0,
		});
		// A default change leaves a line with its own terms alone.
		await setPurchaseUnit(db, {
			productId: blade,
			unit: "BOX",
			packSize: 6,
			minimumQuantity: 1,
		});
		expect((await linesOf(id))[0]).toMatchObject(terms);

		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			unit: "PACK",
			packSize: 4,
			minimumQuantity: 5,
			makeDefault: true,
		});
		const [after] = await db.select().from(schema.productSuppliers);
		// $2 each was $12 a box of 6; a pack of 4 is $8.
		expect(after).toMatchObject({
			unit: "PACK",
			packSize: 4,
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
		expect(await linesOf(id)).toMatchObject([{ unit: "EACH", quantity: 37 }]);
		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			unit: "CASE",
			packSize: 12,
			minimumQuantity: 5,
			makeDefault: false,
		});
		// 37 blades are 4 cases, but the supplier won't sell fewer than 5.
		expect(await linesOf(id)).toMatchObject([
			{ unit: "CASE", packSize: 12, quantity: 5, minimumQuantity: 5 },
		]);
	});

	test("a line set in items converts with the terms it's written with", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			unit: "CASE",
			packSize: 12,
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
		).toEqual({ unit: "CASE", packSize: 12, minimumQuantity: 2, quantity: 3 });
		expect((await linesOf(id))[0]).toMatchObject({ unit: "CASE", quantity: 3 });

		// Terms changed in between are used by the next call.
		await setLineTerms(db, {
			purchaseOrderId: id,
			productId: blade,
			unit: "BOX",
			packSize: 6,
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
		expect((await linesOf(id))[0]).toMatchObject({ unit: "BOX", quantity: 4 });

		// A new line starts with the supplier's terms; no items removes it.
		const knife = await createProduct(db, "KNIFE", "simple");
		await supply(knife, 2);
		const added = await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 7,
			inItems: true,
		});
		expect(added).toMatchObject({ unit: "EACH", packSize: 1, quantity: 7 });
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
			minimumQuantity: 1,
			makeDefault: false,
		});
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 1,
		});
		// 37 wanted, 12 on the PO: raised to 4 cases.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 1,
		});
		expect((await linesOf(id))[0].quantity).toBe(4);
	});

	test("only the product's own supplier's PO can set its default", async () => {
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
				minimumQuantity: 1,
				makeDefault: true,
			}),
		).rejects.toThrow(/another supplier/);
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
			unit: "CASE",
			packSize: 12,
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
			q.startsWith('update "product_suppliers"'),
		);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain('"pack_size"');
	});

	test("a default change locks draft POs, lowest first, before the supplier row", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		const { logging, queries } = logged();
		await setPurchaseUnit(logging, {
			productId: blade,
			unit: "CASE",
			packSize: 12,
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

	test("EACH holds one, and the unit list guards what's in use", async () => {
		await expect(
			setPurchaseUnit(db, {
				productId: blade,
				unit: "EACH",
				packSize: 6,
				minimumQuantity: 1,
			}),
		).rejects.toThrow(/one of the product/);
		await expect(renameUnit(db, "EACH", "UNIT")).rejects.toThrow(/EACH/);
		await expect(deleteUnit(db, "EACH")).rejects.toThrow(/EACH/);

		expect(await addUnit(db, "  bag  of 50 ")).toBe("BAG OF 50");
		await expect(addUnit(db, "bag of 50")).rejects.toThrow(/already/);
		await setPurchaseUnit(db, {
			productId: blade,
			unit: "BAG OF 50",
			packSize: 50,
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
