import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import {
	assembleKits,
	disassembleKits,
	postReceipt,
	recordSale,
	undoBatch,
} from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { applyCost } from "#/inventory/valuation";
import { profitTotals } from "#/orders/profit";
import { createProduct } from "#/test/db";
import { damagesOf, recordDamage, sendDamageReport } from "./damage";
import { splitCharges } from "./landed";
import {
	addLine,
	amendLine,
	markSent,
	openDraft,
	receive,
	removeDiscount,
	saveDiscount,
	undoReceipt,
} from "./orders";
import { addCharge, removeCharge } from "./orders/charges";
import {
	createPurchasingDb,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";

describe("applyCost", () => {
	test("units in blend into the average", () => {
		expect(applyCost(10, 4, { units: 10, value: 50 })).toEqual({
			value: 50,
			avgAfter: 4.5,
			soldValue: 0,
		});
		// Nothing on the shelf, or no cost yet: what came is the cost.
		expect(applyCost(0, 4, { units: 5, value: 35 }).avgAfter).toBe(7);
		expect(applyCost(3, null, { units: 5, value: 35 }).avgAfter).toBe(7);
	});

	test("units with no value come in at the average", () => {
		expect(applyCost(10, 4, { units: 2, value: null })).toEqual({
			value: 8,
			avgAfter: 4,
			soldValue: 0,
		});
	});

	test("value alone splits between shelf and what's sold", () => {
		expect(applyCost(5, 4, { units: 0, value: 10, share: 0.5 })).toEqual({
			value: 10,
			avgAfter: 5,
			soldValue: 5,
		});
		// An empty shelf can't take any.
		expect(applyCost(0, 4, { units: 0, value: 10, share: 1 }).soldValue).toBe(
			10,
		);
	});

	test("what the shelf can't give up comes off what's sold", () => {
		// 2 left at $4, but $50 of a delivery comes back out.
		expect(applyCost(2, 4, { units: -10, value: -50 })).toEqual({
			value: -50,
			avgAfter: 4,
			soldValue: -42,
		});
		// A credit bigger than the shelf is worth stops it at $0.
		expect(applyCost(2, 4, { units: 0, value: -10, share: 1 })).toEqual({
			value: -10,
			avgAfter: 0,
			soldValue: -2,
		});
	});
});

describe("splitCharges", () => {
	const lines = [
		{ lineId: 1, items: 2, gramsEach: 6800, cents: 65_800 },
		{ lineId: 2, items: 20, gramsEach: 450, cents: 10_560 },
		{ lineId: 3, items: 40, gramsEach: 90, cents: 29_280 },
	];

	test("by weight when every line has one", () => {
		const split = splitCharges(60, lines);
		expect(split.method).toBe("weight");
		const total = lines.reduce(
			(n, l) => n + (split.perItem.get(l.lineId) ?? 0) * l.items,
			0,
		);
		expect(total).toBeCloseTo(60);
		// The heavy stilts carry most of it.
		expect(split.perItem.get(1)).toBeCloseTo((60 * 13_600) / 26_200 / 2);
	});

	test("by value when one has no weight, saying which", () => {
		const split = splitCharges(60, [
			lines[0],
			{ ...lines[1], gramsEach: null },
			lines[2],
		]);
		expect(split).toMatchObject({ method: "value", unweighed: [2] });
		expect(split.perItem.get(3)).toBeCloseTo((60 * 29_280) / 105_640 / 40);
	});

	test("evenly when a line has no price or weight", () => {
		const split = splitCharges(10, [
			{ lineId: 1, items: 4, gramsEach: null, cents: null },
			{ lineId: 2, items: 1, gramsEach: null, cents: 500 },
		]);
		expect(split.method).toBe("units");
		expect(split.perItem.get(1)).toBe(2);
	});
});

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

const costOf = async (productId: number) =>
	(
		await db
			.select({ unitCost: schema.products.unitCost })
			.from(schema.products)
			.where(eq(schema.products.id, productId))
	)[0].unitCost;

const entriesOf = (productId: number) =>
	db
		.select()
		.from(schema.costEntries)
		.where(eq(schema.costEntries.productId, productId))
		.orderBy(schema.costEntries.id);

const sellNow = (productId: number, quantity: number) =>
	recordSale(db, {
		productId,
		quantity,
		locationId: warehouse,
		reference: `test:${Math.random()}`,
	});

beforeEach(async () => {
	({ db, warehouse, canam, store } = await createPurchasingDb());
});

describe("received stock's cost", () => {
	let blade: number;
	let knife: number;
	let po: number;
	let bladeLine: number;

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
		po = await openDraft(db, canam);
		await addLine(db, { purchaseOrderId: po, productId: blade, quantity: 44 });
		await addLine(db, { purchaseOrderId: po, productId: knife, quantity: 6 });
		await markSent(db, { purchaseOrderId: po, sentTo: null, now });
		bladeLine = (await linesOf(po))[0].id;
	});

	test("a direct write still leaves an entry", async () => {
		expect(await entriesOf(blade)).toMatchObject([
			{ kind: "set", avgBefore: null, avgAfter: 4, note: "Written directly" },
		]);
	});

	test("undoing a receipt puts the average back exactly", async () => {
		const r = await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 10,
		});
		expect(await costOf(blade)).toBe(4.5);
		await undoReceipt(db, r.receiptId);
		expect(await costOf(blade)).toBe(4);
		const [{ net }] = await db
			.select({ net: sql<number>`sum(value)::float8` })
			.from(schema.costEntries)
			.where(eq(schema.costEntries.purchaseOrderLineId, bladeLine));
		expect(net).toBe(0);
	});

	test("fixing a received line's price revalues its stock", async () => {
		await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 10,
		});
		await amendLine(db, { lineId: bladeLine, unitCost: 6 });
		// 10 at $4 and 10 at $6.
		expect(await costOf(blade)).toBe(5);
		const r = await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 2,
		});
		await undoReceipt(db, r.receiptId);
		expect(await costOf(blade)).toBe(5);
	});

	test("a discount after the delivery comes off its cost, and goes back", async () => {
		await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 10,
		});
		const { id } = await saveDiscount(db, {
			lineId: bladeLine,
			discount: { units: "rest", off: { kind: "percent", percent: 20 } },
		});
		// 20% off $5: 10 at $4 and 10 at $4.
		expect(await costOf(blade)).toBe(4);
		await removeDiscount(db, id);
		expect(await costOf(blade)).toBe(4.5);
	});

	test("late freight lands on what's left, and the rest on what sold", async () => {
		await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 10,
		});
		await sellNow(blade, 15);
		// By value: blades are $220 of the PO's $232.
		const charge = await addCharge(db, {
			purchaseOrderId: po,
			kind: "freight",
			amount: 23.2,
		});
		const freight = 22 / 44;
		const [entry] = (await entriesOf(blade)).slice(-1);
		expect(entry).toMatchObject({ kind: "po_correction", note: `PO ${po}` });
		// 5 of the delivery's 10 are left.
		expect(entry.value).toBeCloseTo(10 * freight);
		expect(entry.soldValue).toBeCloseTo(5 * freight);
		expect(await costOf(blade)).toBeCloseTo(4.5 + freight);
		const totals = await profitTotals(
			db,
			new Date(Date.now() - 60_000),
			new Date(Date.now() + 60_000),
		);
		expect(totals.costCorrections).toBeCloseTo(5 * freight);

		await removeCharge(db, charge.id);
		expect(await costOf(blade)).toBeCloseTo(4.5);
	});

	test("freight goes by weight once every product has one", async () => {
		await db
			.update(schema.products)
			.set({ weightGrams: 100 })
			.where(eq(schema.products.id, blade));
		await db
			.update(schema.products)
			.set({ weightGrams: 1000 })
			.where(eq(schema.products.id, knife));
		await addCharge(db, { purchaseOrderId: po, kind: "freight", amount: 104 });
		await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 10,
		});
		// 4,400 g of blades and 6,000 g of knives share $104: $1 a blade.
		expect(await costOf(blade)).toBe(5);
	});

	test("undoing a receipt after its price was fixed leaves nothing behind", async () => {
		const r = await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 10,
		});
		await amendLine(db, { lineId: bladeLine, unitCost: 6 });
		await undoReceipt(db, r.receiptId);
		expect(await costOf(blade)).toBe(4);
		const entries = await entriesOf(blade);
		expect(entries.every((e) => e.soldValue === 0)).toBe(true);
	});

	test("a charge on a delivery from before costs were kept still lands", async () => {
		// As the old receiving did: stock in, a receipt, the average by hand.
		const { batchId } = await postReceipt(db, {
			productId: blade,
			locationId: warehouse,
			quantity: 10,
			reference: `PO ${po}`,
		});
		await db
			.insert(schema.purchaseOrderReceipts)
			.values({ lineId: bladeLine, quantity: 10, batchId });
		await db
			.update(schema.products)
			.set({ unitCost: 4.5 })
			.where(eq(schema.products.id, blade));
		// $22 of it on the blades, 50¢ each, all 10 still here.
		await addCharge(db, { purchaseOrderId: po, kind: "freight", amount: 23.2 });
		expect(await costOf(blade)).toBe(4.75);
	});

	test("taking off a line added after sending moves its freight onto what came", async () => {
		const screw = await createProduct(db, "SCREW", "simple");
		await supply(screw, 10);
		const { line } = await addLine(db, {
			purchaseOrderId: po,
			productId: screw,
			quantity: 23,
		});
		await addCharge(db, { purchaseOrderId: po, kind: "freight", amount: 462 });
		await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 10,
		});
		// Blades are $220 of the PO's $462: $5 of freight each.
		expect(await costOf(blade)).toBeCloseTo((4 + 10) / 2, 6);
		await amendLine(db, { lineId: line.id, quantity: 0 });
		// Now $220 of $232.
		expect(await costOf(blade)).toBeCloseTo(
			(4 + 5 + (462 * 220) / 232 / 44) / 2,
			3,
		);
	});

	test("asking for a replacement spreads the freight over what's still coming", async () => {
		const knifeLine = (await linesOf(po))[1].id;
		await addCharge(db, { purchaseOrderId: po, kind: "freight", amount: 232 });
		await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 10,
		});
		await receive(db, {
			key: crypto.randomUUID(),
			lineId: knifeLine,
			quantity: 6,
		});
		// Blades are $220 of the PO's $232: $5 of freight each.
		expect(await costOf(blade)).toBeCloseTo((4 + 10) / 2, 6);
		await recordDamage(db, { kind: "missing", lineId: knifeLine, quantity: 2 });
		const [damage] = await damagesOf(db, po);
		await sendDamageReport(db, {
			purchaseOrderId: po,
			remedies: [{ damageId: damage.id, remedy: "replacement" }],
			deliver: async () => "orders@canam.test",
		});
		// Two more knives coming: blades are $220 of $236.
		expect(await costOf(blade)).toBeCloseTo(
			(4 + 5 + (232 * 220) / 236 / 44) / 2,
			3,
		);
	});

	test("an unpriced line comes in at the average until it's priced", async () => {
		await amendLine(db, { lineId: bladeLine, unitCost: null });
		await receive(db, {
			key: crypto.randomUUID(),
			lineId: bladeLine,
			quantity: 10,
		});
		expect(await costOf(blade)).toBe(4);
		await amendLine(db, { lineId: bladeLine, unitCost: 6 });
		expect(await costOf(blade)).toBe(5);
	});
});

describe("a product with no cost yet", () => {
	test("pricing it after it sold gives the sales that cost", async () => {
		const pan = await createProduct(db, "PAN", "simple");
		await supply(pan, null);
		const po = await openDraft(db, canam);
		const { line } = await addLine(db, {
			purchaseOrderId: po,
			productId: pan,
			quantity: 10,
		});
		await markSent(db, { purchaseOrderId: po, sentTo: null, now });
		await receive(db, {
			key: crypto.randomUUID(),
			lineId: line.id,
			quantity: 10,
		});
		await sell(pan, 10);
		await sellNow(pan, 10);
		await amendLine(db, { lineId: line.id, unitCost: 6 });
		expect(await costOf(pan)).toBe(6);
		const [sale] = await db
			.select({ unitCost: schema.orderLines.unitCost })
			.from(schema.orderLines)
			.where(eq(schema.orderLines.productId, pan));
		expect(sale.unitCost).toBe(6);
		// Its cost is on the sale, so none of it is a correction too.
		expect((await entriesOf(pan)).every((e) => e.soldValue === 0)).toBe(true);
	});
});

describe("PO prices", () => {
	test("are the supplier's, never our average", async () => {
		const handle = await createProduct(db, "HANDLE", "simple");
		await supply(handle, null);
		await db
			.update(schema.products)
			.set({ unitCost: 3 })
			.where(eq(schema.products.id, handle));
		const draft = await openDraft(db, canam);
		const { line } = await addLine(db, {
			purchaseOrderId: draft,
			productId: handle,
			quantity: 2,
		});
		expect(line.unitCost).toBeNull();
	});
});

describe("stock that moves without a PO", () => {
	test("building a kit costs its parts, and breaking it gives that back", async () => {
		const kit = await createProduct(db, "KIT", "kit");
		const pan = await createProduct(db, "PAN", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await setRecipe(db, kit, [
			{ productId: pan, quantity: 1 },
			{ productId: knife, quantity: 2 },
		]);
		for (const [id, cost] of [
			[pan, 10],
			[knife, 3],
		])
			await db
				.update(schema.products)
				.set({ unitCost: cost })
				.where(eq(schema.products.id, id));
		await stock(pan, 4);
		await stock(knife, 8);
		await assembleKits(db, {
			kitProductId: kit,
			quantity: 2,
			locationId: warehouse,
		});
		expect(await costOf(kit)).toBe(16);
		// Some made dearer: a kit at $22 breaks into parts worth $22.
		await db
			.update(schema.products)
			.set({ unitCost: 22 })
			.where(eq(schema.products.id, kit));
		await disassembleKits(db, {
			kitProductId: kit,
			quantity: 1,
			locationId: warehouse,
		});
		// The pan's $10 of $16 is $13.75 of $22, onto 2 left at $10.
		expect(await costOf(pan)).toBeCloseTo((2 * 10 + 13.75) / 3);
	});

	test("undoing a build puts back the parts at what they left at", async () => {
		const kit = await createProduct(db, "KIT", "kit");
		const pan = await createProduct(db, "PAN", "simple");
		await setRecipe(db, kit, [{ productId: pan, quantity: 1 }]);
		await db
			.update(schema.products)
			.set({ unitCost: 10 })
			.where(eq(schema.products.id, pan));
		await stock(pan, 2);
		const { batchId } = await assembleKits(db, {
			kitProductId: kit,
			quantity: 1,
			locationId: warehouse,
		});
		await db
			.update(schema.products)
			.set({ unitCost: 20 })
			.where(eq(schema.products.id, pan));
		await undoBatch(db, batchId);
		// One at $20 and the one back at $10: $30, as before.
		expect(await costOf(pan)).toBe(15);
	});

	test("a return comes back at what its sale took", async () => {
		const pan = await createProduct(db, "PAN", "simple");
		await db
			.update(schema.products)
			.set({ unitCost: 4 })
			.where(eq(schema.products.id, pan));
		await stock(pan, 10);
		const { recordReturn } = await import("#/inventory/ledger");
		await recordReturn(db, {
			productId: pan,
			quantity: 1,
			locationId: warehouse,
			reference: "return:1:1",
			sale: null,
			unitCost: 15,
		});
		expect(await costOf(pan)).toBe(5);
	});
});
