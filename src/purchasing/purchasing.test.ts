import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { formatOrderQuantity } from "#/lib/format";
import { createProduct, createTestDb } from "#/test/db";
import { loadOrder, printedLines, supplierRows } from "./load";
import {
	addDraftLine,
	addLine,
	addSetToOtherDrafts,
	amendLine,
	averageCost,
	cancelOrder,
	closeOrder,
	deleteDraft,
	draftFromSuggestions,
	lockDraftLine,
	markSent,
	openDraft,
	openSuggested,
	orderAgain,
	purchaseOrderOfBatch,
	receive,
	receiveExtra,
	refreshSuggested,
	removeAddedLine,
	restoreDraft,
	restoreOrder,
	setDraftLine,
	setPartsOf,
	skipSetPart,
	undoReceipt,
	updateFromSuggestions,
} from "./orders";
import {
	daysUntilReorder,
	explainReorder,
	readyToOrder,
	recommendedAdditions,
	reorderBreakdown,
	reorderQuantity,
	suggestPurchases,
	unitsOnOrder,
	velocityRanks,
} from "./reorder";
import { partState } from "./sets";
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
		safetyStock: 0,
		coverDays: 20,
		minStock: 0,
		minimumQuantity: 1,
		packSize: 1,
		supplierCount: 1,
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

	test("orders earlier, and more, by the safety stock", () => {
		// Reorder point 10 + 5; topped up to 30 + 5.
		expect(reorderQuantity({ ...base, safetyStock: 5, onHand: 15 })).toBe(0);
		expect(reorderQuantity({ ...base, safetyStock: 5, onHand: 14 })).toBe(21);
	});

	test("buys back oversold stock even with no recent sales", () => {
		expect(reorderQuantity({ ...base, dailyDemand: 0, onHand: -2 })).toBe(2);
		expect(reorderQuantity({ ...base, dailyDemand: 0 })).toBe(0);
	});

	test("orders back up to min stock, even with no recent sales", () => {
		expect(reorderQuantity({ ...base, dailyDemand: 0, minStock: 3 })).toBe(3);
		expect(
			reorderQuantity({ ...base, dailyDemand: 0, minStock: 3, onHand: 2 }),
		).toBe(1);
		expect(
			reorderQuantity({ ...base, dailyDemand: 0, minStock: 3, onHand: 3 }),
		).toBe(0);
		// Min above the usual reorder point raises it: 15 on hand lasts the lead
		// time, but not past min.
		expect(reorderQuantity({ ...base, minStock: 20, onHand: 15 })).toBe(15);
	});

	test("counts days until it needs ordering", () => {
		expect(daysUntilReorder({ ...base, onHand: 15 })).toBe(5);
		expect(daysUntilReorder({ ...base, onHand: 10 })).toBe(0);
		expect(daysUntilReorder({ ...base, onHand: 9 })).toBeNull();
		expect(daysUntilReorder({ ...base, dailyDemand: 0 })).toBeNull();
	});
});

describe("explainReorder", () => {
	const base = {
		dailyDemand: 1,
		onHand: 0,
		onOrder: 0,
		leadTimeDays: 10,
		safetyStock: 4,
		coverDays: 20,
		minStock: 0,
		minimumQuantity: 1,
		packSize: 1,
		supplierCount: 1,
	};
	const context = {
		inStockDays: 90,
		rank: 0.5,
		leadTime: { days: 10, from: "supplier" as const, pos: 0 },
		abc: "B" as const,
		purchase: {
			unit: "EACH",
			packSize: 1,
			supplierCount: 1,
			minimumQuantity: 1,
		},
	};

	test("breaks the aim into parts that add up to it", () => {
		const why = explainReorder({ ...base, dailyDemand: 0.73 }, context);
		if (why.aim.kind !== "forecast") throw new Error("expected forecast");
		const { restock, safetyStock, cover, total } = why.aim;
		expect(restock + safetyStock + cover).toBe(total);
		expect(why.orderBelow).toBe(restock + safetyStock);
	});

	test("orders what reorderQuantity orders, and says why it's rounded", () => {
		const input = {
			...base,
			onHand: 5,
			onOrder: 3,
			packSize: 12,
			supplierCount: 12,
		};
		const why = explainReorder(input, {
			...context,
			purchase: {
				unit: "CASE",
				packSize: 12,
				supplierCount: 12,
				minimumQuantity: 1,
			},
		});
		// Aim 34, have 8: short 26, so 3 cases of 12.
		expect(why.verdict).toEqual({
			kind: "order",
			quantity: reorderQuantity(input),
			units: 36,
			roundedUp: "pack",
		});
		expect(
			explainReorder({ ...base, minimumQuantity: 50 }, context).verdict,
		).toMatchObject({ quantity: 50, roundedUp: "minimum" });
	});

	test("waits, or does nothing, when stock covers the reorder point", () => {
		expect(explainReorder({ ...base, onHand: 20 }, context).verdict).toEqual({
			kind: "later",
			days: 6,
		});
		expect(
			explainReorder({ ...base, dailyDemand: 0, safetyStock: 0 }, context)
				.verdict,
		).toEqual({ kind: "idle" });
	});

	test("lets min stock set the aim when it's more than sales call for", () => {
		const why = explainReorder({ ...base, minStock: 50 }, context);
		expect(why.aim).toEqual({ kind: "min", total: 50, forecast: 34 });
		expect(why.orderBelow).toBe(50);
	});
});

test("velocityRanks spreads selling products from 0 to 1, ties sharing", () => {
	const f = (dailyDemand: number) => ({
		dailyDemand,
		dailySd: 0,
		inStockDays: 90,
	});
	const ranks = velocityRanks(
		new Map([
			[1, f(0)],
			[2, f(1)],
			[3, f(2)],
			[4, f(2)],
			[5, f(5)],
		]),
	);
	expect(Object.fromEntries(ranks)).toEqual({ 2: 0, 3: 1 / 3, 4: 1 / 3, 5: 1 });
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
		unitPrice: 100,
	});
}

async function supply(productId: number, cost: number | null, minimum = 1) {
	await db.insert(schema.productSuppliers).values({
		productId,
		supplierId: canam,
		supplierCount: 1,
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
		// 60 sold over 90 days, for 10 + 20 days, plus safety stock
		// capped at the lead time's 7 (all sold on one day): 27.
		expect(s.lines).toMatchObject([{ sku: "BLADE", sold: 60, quantity: 27 }]);
		expect(s).toMatchObject({
			total: 135,
			readiness: "minimum",
			draftId: null,
		});
	});

	test("isn't ready below the supplier's minimum, and lists unpriced lines", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await supply(blade, 1);
		await supply(knife, null);
		await stock(knife, -1);
		await sell(blade, 90);
		// Unsold, so a C item: only marked critical does it go on the PO.
		await db
			.update(schema.products)
			.set({ critical: true })
			.where(eq(schema.products.id, knife));
		await db
			.update(schema.suppliers)
			.set({ criticalThreshold: 3 })
			.where(eq(schema.suppliers.id, canam));

		const [s] = await suggestPurchases(db, now);
		expect(s.lines.map((l) => l.sku)).toEqual(["BLADE", "KNIFE"]);
		// Blade is an A item: 1 a day for 10 + 20 days plus 10
		// safety (capped at the lead time's demand; it all sold on one day).
		expect(s).toMatchObject({ total: 40, unpriced: 1, readiness: "waiting" });
	});

	test("is ready below the minimum once enough critical products need it", async () => {
		const blade = await createProduct(db, "BLADE", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await supply(blade, 1);
		await supply(knife, 1);
		await sell(blade, 90); // an A item, so critical
		await stock(knife, -1);

		let [s] = await suggestPurchases(db, now);
		expect(s).toMatchObject({ critical: 1, readiness: "waiting" });

		await db
			.update(schema.products)
			.set({ critical: true })
			.where(eq(schema.products.id, knife));
		[s] = await suggestPurchases(db, now);
		expect(s).toMatchObject({ critical: 2, readiness: "critical" });

		await db
			.update(schema.suppliers)
			.set({ criticalThreshold: 3 })
			.where(eq(schema.suppliers.id, canam));
		[s] = await suggestPurchases(db, now);
		expect(s.readiness).toBe("waiting");
	});
});

describe("reorderBreakdown", () => {
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

describe("recommendedAdditions", () => {
	test("lists what will need ordering within cover days, soonest first", async () => {
		const soon = await createProduct(db, "SOON", "simple");
		const later = await createProduct(db, "LATER", "simple");
		const far = await createProduct(db, "FAR", "simple");
		const now_ = await createProduct(db, "NOW", "simple");
		const onDraft = await createProduct(db, "ONDRAFT", "simple");
		for (const id of [soon, later, far, now_, onDraft]) await supply(id, 2);
		// Each sells 1 a day; lead time is 10, cover 20.
		for (const id of [soon, later, far, now_, onDraft]) await sell(id, 90);
		await stock(soon, 23);
		await stock(later, 30);
		await stock(far, 55);
		await stock(now_, 5);
		await stock(onDraft, 12);

		const r = await recommendedAdditions(db, canam, new Set([onDraft]), now);
		// All are A items whose sales came in one order, so safety stock is
		// capped at the lead time's 10: the reorder point is 20 and a top-up goes
		// to 40. NOW needs ordering today, so it's a suggestion instead; FAR
		// lasts past cover.
		expect(r.map((l) => [l.sku, l.due, l.quantity, l.critical])).toEqual([
			["SOON", 3, 17, true],
			["LATER", 10, 10, true],
		]);
	});

	test("puts C items that need ordering first, filled to max, instead of on the PO", async () => {
		const top = await createProduct(db, "TOP", "simple");
		const slow = await createProduct(db, "SLOW", "simple");
		const counted = await createProduct(db, "COUNTED", "simple");
		const dormant = await createProduct(db, "DORMANT", "simple");
		for (const id of [top, slow, counted, dormant]) await supply(id, 2);
		await sell(top, 90);
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

		const r = await recommendedAdditions(db, canam, new Set(), now);
		// DORMANT never sold and was never counted, so it's left out. The rest
		// fill to their max of 12, less what's on the shelf.
		expect(r.map((l) => [l.sku, l.due, l.quantity])).toEqual([
			["COUNTED", "now", 11],
			["SLOW", "now", 12],
			["TOP", 3, 17],
		]);
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
			// 4 every 3 days for 10 + 20 days plus safety capped at
			// the lead time's demand (an A item), less
			// the 10 on hand.
			{ productId: blade, quantity: 44, unitCost: 5 },
			// 3 needed, but the supplier sells at least 6.
			{ productId: knife, quantity: 6, unitCost: 2 },
		]);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 50,
		});
		expect(await draftFromSuggestions(db, canam, now)).toBe(id);
		expect((await linesOf(id))[0].quantity).toBe(50);

		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 0,
		});
		expect(await linesOf(id)).toHaveLength(1);
	});

	test("Update skips a locked line until it's unlocked", async () => {
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 2,
		});
		await lockDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			locked: true,
		});
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 1,
			raised: 0,
		});
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([2, 6]);

		await lockDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			locked: false,
		});
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 1,
		});
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([44, 6]);
	});

	test("a frozen draft updates on request: adds new, raises short, never lowers", async () => {
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 2,
		});
		// Blade (suggested 44) is short of what's suggested; the knife is new.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 1,
			raised: 1,
		});
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([44, 6]);
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
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([44, 50]);

		await markSent(db, { purchaseOrderId: id, sentTo: null });
		await expect(updateFromSuggestions(db, id, now)).rejects.toThrow(/is sent/);
	});

	test("adding never changes a line already there; only one of two adds lands", async () => {
		const id = await openDraft(db, canam);
		const [first, second] = await Promise.all([
			addDraftLine(db, { purchaseOrderId: id, productId: blade, quantity: 5 }),
			addDraftLine(db, { purchaseOrderId: id, productId: blade, quantity: 9 }),
		]);
		expect([first.added, second.added].sort()).toEqual([false, true]);
		const kept = first.added ? first : second;
		expect(await linesOf(id)).toMatchObject([
			{ productId: blade, quantity: kept.line.quantity, unitCost: 5 },
		]);
		const other = first.added ? second : first;
		expect(other.line).toEqual(kept.line);
	});

	test("undoing an add leaves the line alone if it's been changed since", async () => {
		const id = await openDraft(db, canam);
		const { line } = await addDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 5,
		});
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 5,
			unitCost: 6,
		});
		expect(await removeAddedLine(db, { purchaseOrderId: id, line })).toBe(
			false,
		);
		expect(await linesOf(id)).toMatchObject([{ quantity: 5, unitCost: 6 }]);

		const knifeAdd = await addDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 6,
		});
		expect(
			await removeAddedLine(db, { purchaseOrderId: id, line: knifeAdd.line }),
		).toBe(true);
		expect(await linesOf(id)).toHaveLength(1);
		// Once it's gone, a second undo finds nothing to take off.
		expect(
			await removeAddedLine(db, { purchaseOrderId: id, line: knifeAdd.line }),
		).toBe(false);
	});

	test("undoing an add leaves the draft it started", async () => {
		const id = await openDraft(db, canam);
		const { line } = await addDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 6,
		});
		expect(await removeAddedLine(db, { purchaseOrderId: id, line })).toBe(true);
		expect(await linesOf(id)).toEqual([]);
		expect(await openDraft(db, canam)).toBe(id);
	});

	test("a tool set is its own line until sent, then becomes its parts", async () => {
		const handle = await createProduct(db, "HANDLE", "simple");
		await db
			.update(schema.products)
			.set({ unitCost: 3 })
			.where(eq(schema.products.id, handle));
		// No price from Canam, so it's the product's own cost.
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
			// 44 suggested plus 2 in each of 3 sets.
			{ productId: blade, quantity: 50 },
			{ productId: knife, quantity: 6 },
			// Not on the draft before: a new line, at the product's own cost.
			{ productId: handle, quantity: 3, unit: "EACH", unitCost: 3 },
		]);
	});

	test("a set orders only its parts bought from the PO's supplier", async () => {
		const [{ id: other }] = await db
			.insert(schema.suppliers)
			.values({ code: "OTHER", name: "Other", leadTimeDays: 5 })
			.returning();
		const handle = await createProduct(db, "HANDLE", "simple");
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
		// 8 blades and 4 knives in the sets: 36 more blades (44 suggested), and
		// 2 knives rounded up to the supplier's 6.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 2,
			raised: 0,
		});
		expect(await linesOf(id)).toMatchObject([
			{ productId: blade, quantity: 36 },
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
		).rejects.toThrow(/no parts yet/);
		await expect(
			addDraftLine(db, { purchaseOrderId: id, productId: set, quantity: 1 }),
		).rejects.toThrow(/no parts yet/);

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
				supplierCount: 12,
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
			unit: "PACK",
			packSize: 1,
			supplierCount: 1,
			minimumQuantity: 1,
		});
		const id = await draftFromSuggestions(db, canam, now);
		await setPurchaseUnit(db, {
			productId: blade,
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
