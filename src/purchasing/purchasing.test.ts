import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import {
	addSuggestions,
	averageCost,
	cancelOrder,
	closeOrder,
	draftFromSuggestions,
	markSent,
	openDraft,
	receive,
	setDraftLine,
	undoReceipt,
} from "./orders";
import { reorderQuantity, suggestPurchases, unitsOnOrder } from "./reorder";

const now = new Date("2026-10-10T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe("reorderQuantity", () => {
	const base = {
		dailyDemand: 1,
		onHand: 0,
		onOrder: 0,
		leadTimeDays: 10,
		coverDays: 20,
		minimumQuantity: 1,
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
		// 60 sold over 90 days, for 10 + 20 days: 20 to order.
		expect(s.lines).toMatchObject([{ sku: "BLADE", sold: 60, quantity: 20 }]);
		expect(s).toMatchObject({ total: 100, ready: true, draftId: null });
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
		expect(s).toMatchObject({ total: 30, unpriced: 1, ready: false });
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
			{ productId: blade, quantity: 30, unitCost: 5 },
			// 3 needed, but the supplier sells at least 6.
			{ productId: knife, quantity: 6, unitCost: 2 },
		]);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 35,
		});
		expect(await draftFromSuggestions(db, canam, now)).toBe(id);
		expect((await linesOf(id))[0].quantity).toBe(35);

		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 0,
		});
		expect(await linesOf(id)).toHaveLength(1);
	});

	test("a blank PO pulls in what needs reordering, once", async () => {
		const id = await openDraft(db, canam);
		expect(await linesOf(id)).toEqual([]);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 2,
		});
		// Only the knife is new; the blade keeps the 2 set by hand.
		expect(await addSuggestions(db, id, now)).toBe(1);
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([2, 6]);
		expect(await addSuggestions(db, id, now)).toBe(0);

		await markSent(db, { purchaseOrderId: id, sentTo: null });
		await expect(addSuggestions(db, id, now)).rejects.toThrow(/is sent/);
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

	test("receives in parts, averages cost, closes when complete, undoes", async () => {
		const id = await draftFromSuggestions(db, canam, now);
		await markSent(db, { purchaseOrderId: id, sentTo: "a@b.c", now });
		expect(await getPo(id)).toMatchObject({
			status: "sent",
			expectedAt: new Date("2026-10-20T12:00:00Z"),
		});
		expect((await unitsOnOrder(db)).get(blade)).toBe(30);
		// On order now, so nothing more is suggested.
		expect(await suggestPurchases(db, now)).toEqual([]);

		const [bladeLine, knifeLine] = await linesOf(id);
		await receive(db, { lineId: bladeLine.id, quantity: 10 });
		expect((await unitsOnOrder(db)).get(blade)).toBe(20);
		const [product] = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, blade));
		// 10 on the shelf at $4, 10 more at $5.
		expect(product.unitCost).toBe(4.5);

		const last = await receive(db, { lineId: bladeLine.id, quantity: 20 });
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
