import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import { loadOrder } from "./load";
import {
	addDraftLine,
	draftFromSuggestions,
	lockDraftLine,
	markSent,
	openDraft,
	removeAddedLine,
	setDraftLine,
	updateFromSuggestions,
} from "./orders";
import {
	createPurchasingDb,
	now,
	purchasingBuilders,
} from "./purchasing.fixtures";

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
			// 120 sold in the last 20 days, less the 10 on hand.
			{ productId: blade, quantity: 110, unitCost: 5 },
			// 9 sold, none on hand; over the supplier's minimum of 6.
			{ productId: knife, quantity: 9, unitCost: 2 },
		]);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 150,
		});
		expect(await draftFromSuggestions(db, canam, now)).toBe(id);
		// Above the 110 suggested, so it stays.
		expect((await linesOf(id))[0].quantity).toBe(150);

		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 0,
		});
		expect(await linesOf(id)).toHaveLength(1);
	});

	test("lines list in the order they were added, not by name", async () => {
		const id = await openDraft(db, canam);
		const set = (productId: number, quantity: number) =>
			setDraftLine(db, { purchaseOrderId: id, productId, quantity });
		const order = async () =>
			(await loadOrder(db, id)).lines.map((l) => l.productId);
		await set(knife, 6);
		await set(blade, 5);
		expect(await order()).toEqual([knife, blade]);
		// Changing a line leaves it where it is.
		await set(knife, 12);
		expect(await order()).toEqual([knife, blade]);
		// Put back with its old time, as Undo does, it's where it sat.
		const [first] = (await loadOrder(db, id)).lines;
		await set(knife, 0);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: knife,
			quantity: 12,
			addedAt: first.addedAt,
		});
		expect(await order()).toEqual([knife, blade]);
		// Taken off and added again, it's the newest.
		await set(knife, 0);
		await set(knife, 6);
		expect(await order()).toEqual([blade, knife]);
		// A time still to come counts as now.
		await set(blade, 0);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 5,
			addedAt: new Date(Date.now() + 86_400_000),
		});
		expect((await loadOrder(db, id)).lines[1].addedAt.getTime()).toBeLessThan(
			Date.now() + 1000,
		);
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
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([2, 9]);

		await lockDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			locked: false,
		});
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 0,
			raised: 1,
		});
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([110, 9]);
	});

	test("a frozen draft updates on request: adds new, raises short, never lowers", async () => {
		const id = await openDraft(db, canam);
		await setDraftLine(db, {
			purchaseOrderId: id,
			productId: blade,
			quantity: 2,
		});
		// Blade (suggested 110) is short of what's suggested; the knife is new.
		expect(await updateFromSuggestions(db, id, now)).toEqual({
			added: 1,
			raised: 1,
		});
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([110, 9]);
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
		expect((await linesOf(id)).map((l) => l.quantity)).toEqual([110, 50]);

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
});
