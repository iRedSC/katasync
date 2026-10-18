import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	type Discount,
	discountProblem,
	lineTotal,
	receiptUnitCost,
} from "./discount";
import { matchInvoice } from "./invoices";
import { loadOrder, printedLines } from "./load";
import {
	addDraftLine,
	amendLine,
	deleteDraft,
	markSent,
	openDraft,
	receive,
	receiveExtra,
	removeAddedLine,
	removeDiscount,
	restoreDraft,
	saveDiscount,
	setDraftLine,
	undoReceipt,
} from "./orders";
import { setLineTerms } from "./units";

const pct = (percent: number) => ({ kind: "percent" as const, percent });
const usd = (amount: number) => ({ kind: "amount" as const, amount });

describe("discount math", () => {
	const line = { quantity: 10, unitCost: 5 };

	test("a percent of the rest follows the quantity; an amount is for its units together", () => {
		const d: Discount[] = [
			{ units: 2, off: usd(3) },
			{ units: "rest", off: pct(10) },
		];
		// $50, less $3, less 10% of the other 8 ($4).
		expect(lineTotal(line, d)).toBe(43);
		expect(lineTotal({ ...line, quantity: 12 }, d)).toBe(52);
		expect(lineTotal({ ...line, unitCost: null }, d)).toBeNull();
	});

	test("refuses covering more than the line, more than it costs, or two rests", () => {
		expect(discountProblem(line, [{ units: 11, off: pct(5) }])).toMatch(
			/cover 11, but the line has 10/,
		);
		expect(discountProblem(line, [{ units: 2, off: usd(10.01) }])).toMatch(
			/more than they cost/,
		);
		expect(discountProblem(line, [{ units: 2, off: usd(10) }])).toBeNull();
		expect(
			discountProblem(line, [
				{ units: "rest", off: pct(5) },
				{ units: "rest", off: pct(5) },
			]),
		).toMatch(/Only one/);
		// No price yet: an amount can't be checked against it.
		expect(
			discountProblem({ ...line, unitCost: null }, [
				{ units: 1, off: usd(99) },
			]),
		).toBeNull();
	});

	test("discounts rounding to the cent on their own never take a line below $0", () => {
		const free = { units: 1, off: pct(100) };
		expect(lineTotal({ quantity: 2, unitCost: 0.005 }, [free, free])).toBe(0);
		expect(lineTotal({ quantity: 2, unitCost: 0.335 }, [free, free])).toBe(0);
	});

	test("a free unit in a receipt costs nothing; the line's discounts spread over the rest", () => {
		const discounts = [
			{ units: "rest" as const, off: pct(10), receiptId: null },
			{ units: 1, off: pct(100), receiptId: 7 },
		];
		const at = (id: number, quantity: number) =>
			receiptUnitCost({
				line: { quantity: 11, unitCost: 5 },
				discounts,
				receipt: { id, quantity },
			});
		expect(at(6, 10)).toBeCloseTo(4.5);
		expect(at(7, 1)).toBe(0);
		// One box of all 11: 10 at $4.50 and 1 free.
		expect(at(7, 11)).toBeCloseTo(45 / 11);
	});
});

describe("discounts on a PO", () => {
	let db: Db;
	let blade: number;
	let po: number;
	let lineId: number;

	const total = async () => {
		const { lines } = await loadOrder(db, po);
		return lines.map((l) => lineTotal(l, l.discounts));
	};
	const productCost = async () =>
		(
			await db
				.select({ cost: schema.products.unitCost })
				.from(schema.products)
				.where(eq(schema.products.id, blade))
		)[0].cost;

	beforeEach(async () => {
		db = await createTestDb();
		await db.insert(schema.locations).values({ name: "W", kind: "owned" });
		const [{ id: supplier }] = await db
			.insert(schema.suppliers)
			.values({ code: "S", name: "S", leadTimeDays: 10, coverDays: 20 })
			.returning();
		blade = await createProduct(db, "BLADE", "simple");
		await db.insert(schema.productSuppliers).values({
			productId: blade,
			supplierId: supplier,
			supplierCount: 1,
			cost: 5,
		});
		po = await openDraft(db, supplier);
		await setDraftLine(db, {
			purchaseOrderId: po,
			productId: blade,
			quantity: 10,
		});
		lineId = (await loadOrder(db, po)).lines[0].id;
	});

	test("a draft's discount prints when sent, and keeps printing once taken off", async () => {
		const { id } = await saveDiscount(db, {
			lineId,
			discount: { units: "rest", off: pct(10) },
		});
		expect(await total()).toEqual([45]);
		await markSent(db, { purchaseOrderId: po, sentTo: null });

		const removed = await removeDiscount(db, id);
		expect(removed).toMatchObject({ units: "rest", off: pct(10) });
		expect(await total()).toEqual([50]);
		const order = await loadOrder(db, po);
		expect(printedLines(order.lines, order.order.sentAt)).toMatchObject([
			{ quantity: 10, discounts: [{ units: "rest", off: pct(10) }] },
		]);
		expect(order.discountHistory).toMatchObject([
			{ id, sent: true, removedAt: expect.any(Date) },
		]);
		await expect(removeDiscount(db, id)).rejects.toThrow(/already off/);
	});

	test("a line can't drop below what its discounts cover, nor its price below an amount", async () => {
		await saveDiscount(db, { lineId, discount: { units: 6, off: usd(12) } });
		await expect(
			setDraftLine(db, { purchaseOrderId: po, productId: blade, quantity: 5 }),
		).rejects.toThrow(/BLADE: Discounts cover 6, but the line has 5/);
		await expect(
			setDraftLine(db, {
				purchaseOrderId: po,
				productId: blade,
				quantity: 10,
				unitCost: 1.5,
			}),
		).rejects.toThrow(/\$12\.00 off 6 is more than they cost \(\$9\.00\)/);
		await expect(
			saveDiscount(db, { lineId, discount: { units: 5, off: pct(5) } }),
		).rejects.toThrow(/cover 11/);
		await saveDiscount(db, {
			lineId,
			discount: { units: "rest", off: pct(5) },
		});
		await expect(
			saveDiscount(db, { lineId, discount: { units: "rest", off: pct(1) } }),
		).rejects.toThrow(/Only one discount can cover all the rest/);
		await expect(
			saveDiscount(db, { lineId, discount: { units: 1, off: usd(0.001) } }),
		).rejects.toThrow(/whole cents/);

		await markSent(db, { purchaseOrderId: po, sentTo: null });
		await expect(amendLine(db, { lineId, quantity: 4 })).rejects.toThrow(
			/cover 6/,
		);
		// Nothing changed.
		expect(await total()).toEqual([50 - 12 - 1]);
	});

	test("replacing a discount edits it in one change", async () => {
		const first = await saveDiscount(db, {
			lineId,
			discount: { units: 10, off: pct(10) },
		});
		// Would cover 20 if both stayed.
		await saveDiscount(db, {
			lineId,
			discount: { units: 10, off: pct(20) },
			replaces: first.id,
		});
		expect(await total()).toEqual([40]);
	});

	test("free in the box: the line expects it, bills nothing for it, and the stock costs less", async () => {
		await saveDiscount(db, {
			lineId,
			discount: { units: "rest", off: pct(10) },
		});
		await markSent(db, { purchaseOrderId: po, sentTo: null });
		await receive(db, { lineId, quantity: 10 });
		expect(await productCost()).toBe(4.5);

		// All 10 closed it; one more turns up in the box.
		const free = await receiveExtra(db, {
			purchaseOrderId: po,
			productId: blade,
			quantity: 1,
			discount: { off: pct(100) },
		});
		const { lines } = await loadOrder(db, po);
		expect(lines[0]).toMatchObject({ quantity: 11, received: 11 });
		expect(await total()).toEqual([45]);
		// 10 at $4.50 and 1 at $0.
		expect(await productCost()).toBeCloseTo(45 / 11, 4);
		// The supplier's price stays the price before discounts.
		const [link] = await db.select().from(schema.productSuppliers);
		expect(link.cost).toBe(5);

		await undoReceipt(db, free.receiptId);
		const after = await loadOrder(db, po);
		expect(after.lines[0].quantity).toBe(10);
		expect(after.lines[0].discounts).toHaveLength(1);
		expect(await total()).toEqual([45]);
	});

	test("putting back a delivery's discount keeps it with the delivery", async () => {
		await markSent(db, { purchaseOrderId: po, sentTo: null });
		const { receiptId } = await receive(db, {
			lineId,
			quantity: 2,
			discount: { units: 1, off: pct(100) },
		});
		const [d] = (await loadOrder(db, po)).lines[0].discounts;
		const removed = await removeDiscount(db, d.id);
		expect(removed.receiptId).toBe(receiptId);
		await saveDiscount(db, {
			lineId,
			discount: { units: removed.units, off: removed.off },
			receiptId,
		});
		await undoReceipt(db, receiptId);
		expect((await loadOrder(db, po)).lines[0].discounts).toEqual([]);
		// That delivery is gone now.
		await expect(
			saveDiscount(db, {
				lineId,
				discount: { units: 1, off: pct(100) },
				receiptId,
			}),
		).rejects.toThrow(/isn't on this line/);
	});

	test("an invoice billing before discounts doesn't match; one with the credit does", async () => {
		await saveDiscount(db, {
			lineId,
			discount: { units: "rest", off: pct(10) },
		});
		await markSent(db, { purchaseOrderId: po, sentTo: null });
		const billed = { sku: "BLADE", quantity: 10, unitCost: 5 };
		const without = await matchInvoice(db, {
			purchaseOrderId: po,
			lines: [billed],
		});
		expect(without).toMatchObject({
			matches: false,
			totals: { poTotal: 45, poDiscounts: 5, invoiceOverPo: 5 },
		});
		expect(without.note).toMatch(/\$5\.00 of discounts/);
		const credited = await matchInvoice(db, {
			purchaseOrderId: po,
			lines: [billed, { description: "Discount", quantity: 1, unitCost: -5 }],
		});
		expect(credited).toMatchObject({ matches: true, notOnPo: [] });
		expect(credited.credits).toHaveLength(1);
		// Billed net instead.
		const net = await matchInvoice(db, {
			purchaseOrderId: po,
			lines: [{ sku: "BLADE", quantity: 10, unitCost: 4.5 }],
		});
		expect(net.matches).toBe(true);
	});

	test("a receipt's discount covers at most what came", async () => {
		await markSent(db, { purchaseOrderId: po, sentTo: null });
		await expect(
			receive(db, {
				lineId,
				quantity: 2,
				discount: { units: 3, off: pct(50) },
			}),
		).rejects.toThrow(/1 to 2/);
		const knife = await createProduct(db, "KNIFE", "simple");
		await receiveExtra(db, {
			purchaseOrderId: po,
			productId: knife,
			quantity: 2,
			discount: { off: pct(100) },
		});
		const knifeLine = (await loadOrder(db, po)).lines.find(
			(l) => l.productId === knife,
		);
		expect(knifeLine?.discounts).toMatchObject([{ units: 2, off: pct(100) }]);
	});

	test("deleting a draft and bringing it back keeps its discounts", async () => {
		await saveDiscount(db, { lineId, discount: { units: 4, off: usd(2) } });
		const deleted = await deleteDraft(db, po);
		await restoreDraft(db, deleted);
		expect((await loadOrder(db, po)).lines[0].discounts).toMatchObject([
			{ units: 4, off: usd(2) },
		]);
	});

	test("a pack size change converts discounts, or refuses ones that don't fit", async () => {
		const terms = {
			purchaseOrderId: po,
			productId: blade,
			unit: "CASE",
			packSize: 5,
			supplierCount: 5,
			minimumQuantity: 1,
			makeDefault: false,
		};
		const { id } = await saveDiscount(db, {
			lineId,
			discount: { units: 3, off: usd(1) },
		});
		await expect(setLineTerms(db, terms)).rejects.toThrow(/covers 3 of it/);
		await saveDiscount(db, {
			lineId,
			discount: { units: 10, off: usd(1) },
			replaces: id,
		});
		await setLineTerms(db, terms);
		expect((await loadOrder(db, po)).lines[0]).toMatchObject({
			quantity: 2,
			discounts: [{ units: 2, off: usd(1) }],
		});
	});

	test("undoing an add leaves a line someone discounted since", async () => {
		const knife = await createProduct(db, "KNIFE", "simple");
		const { line } = await addDraftLine(db, {
			purchaseOrderId: po,
			productId: knife,
			quantity: 2,
		});
		await saveDiscount(db, {
			lineId: line.id,
			discount: { units: 1, off: usd(1) },
		});
		expect(await removeAddedLine(db, { purchaseOrderId: po, line })).toBe(
			false,
		);
	});
});
