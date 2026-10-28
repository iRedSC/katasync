import { eq } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	receive,
	receiveAll,
	receivedOf,
	receiveExtra,
	setBackOrdered,
	undoReceipts,
} from "./orders";

let db: Db;
let poId: number;
let caseLine: number;
let eachLine: number;
let lateLine: number;
let blade: number;
let knife: number;

async function onHand(productId: number) {
	const [level] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, productId));
	return level?.onHand ?? 0;
}

async function status() {
	const [po] = await db
		.select({ status: schema.purchaseOrders.status })
		.from(schema.purchaseOrders)
		.where(eq(schema.purchaseOrders.id, poId));
	return po.status;
}

beforeEach(async () => {
	db = await createTestDb();
	blade = await createProduct(db, "BLADE", "simple");
	knife = await createProduct(db, "KNIFE", "simple");
	const tape = await createProduct(db, "TAPE", "simple");
	const [supplier] = await db
		.insert(schema.suppliers)
		.values({ code: "CANAM", name: "CanAm" })
		.returning();
	const [location] = await db
		.insert(schema.locations)
		.values({ name: "Shop", kind: "owned" })
		.returning();
	const [po] = await db
		.insert(schema.purchaseOrders)
		.values({
			supplierId: supplier.id,
			locationId: location.id,
			status: "sent",
		})
		.returning();
	poId = po.id;
	const lines = await db
		.insert(schema.purchaseOrderLines)
		.values([
			{
				purchaseOrderId: po.id,
				productId: blade,
				unit: "CASE",
				packSize: 12,
				supplierCount: 12,
				quantity: 2,
			},
			{
				purchaseOrderId: po.id,
				productId: knife,
				supplierCount: 1,
				quantity: 5,
			},
			{
				purchaseOrderId: po.id,
				productId: tape,
				supplierCount: 1,
				quantity: 4,
			},
		])
		.returning();
	[caseLine, eachLine, lateLine] = lines.map((l) => l.id);
});

test("receives the rest of every line but the back-ordered ones", async () => {
	await receive(db, {
		key: crypto.randomUUID(),
		lineId: eachLine,
		quantity: 2,
	});
	await setBackOrdered(db, { lineId: lateLine, backOrdered: true });
	const { receipts, closed } = await receiveAll(db, {
		key: crypto.randomUUID(),
		purchaseOrderId: poId,
	});
	expect(receipts.map((r) => [r.lineId, r.quantity])).toEqual([
		[caseLine, 2],
		[eachLine, 3],
	]);
	expect(closed).toBe(false);
	expect(await onHand(blade)).toBe(24);
	expect(await onHand(knife)).toBe(5);
	expect(await receivedOf(db, lateLine)).toBe(0);
	expect(await status()).toBe("sent");
});

test("closes the PO when that's everything, and undoes as one", async () => {
	await receive(db, {
		key: crypto.randomUUID(),
		lineId: eachLine,
		quantity: 2,
	});
	const { receipts, closed } = await receiveAll(db, {
		key: crypto.randomUUID(),
		purchaseOrderId: poId,
	});
	expect(closed).toBe(true);
	expect(await status()).toBe("closed");
	await undoReceipts(
		db,
		receipts.map((r) => r.receiptId),
	);
	expect(await status()).toBe("sent");
	expect(await onHand(blade)).toBe(0);
	// The receipt from before Receive all stays.
	expect(await receivedOf(db, eachLine)).toBe(2);
});

test("refuses when nothing is left to receive", async () => {
	await receiveAll(db, { key: crypto.randomUUID(), purchaseOrderId: poId });
	await expect(
		receiveAll(db, { key: crypto.randomUUID(), purchaseOrderId: poId }),
	).rejects.toThrow();
});

test("a resent Receive all answers as before, even once the PO closed", async () => {
	const once = { key: crypto.randomUUID(), purchaseOrderId: poId };
	const first = await receiveAll(db, once);
	expect(first.closed).toBe(true);
	expect(await receiveAll(db, once)).toEqual(first);
	expect(await onHand(blade)).toBe(24);
	expect(await onHand(knife)).toBe(5);
	await expect(
		receive(db, { key: once.key, lineId: eachLine, quantity: 1 }),
	).rejects.toThrow(/recorded for something else/);
});

const knifeTrail = async () => ({
	receipts: (await db.select().from(schema.purchaseOrderReceipts)).length,
	movements: (
		await db
			.select()
			.from(schema.movements)
			.where(eq(schema.movements.productId, knife))
	).length,
	onHand: await onHand(knife),
});

test("a key used for one receipt refuses any other, of any kind", async () => {
	const key = crypto.randomUUID();
	await receive(db, { key, lineId: eachLine, quantity: 2 });
	for (const other of [
		() => receive(db, { key, lineId: eachLine, quantity: 3 }),
		() => receive(db, { key, lineId: lateLine, quantity: 2 }),
		() => receiveAll(db, { key, purchaseOrderId: poId }),
		() =>
			receiveExtra(db, {
				key,
				purchaseOrderId: poId,
				productId: knife,
				quantity: 2,
			}),
	])
		await expect(other()).rejects.toThrow(/recorded for something else/);
	expect(await knifeTrail()).toEqual({ receipts: 1, movements: 1, onHand: 2 });
});

test("a receipt that fails before it commits leaves nothing; its retry receives once", async () => {
	// Recording the key fails, once, after the stock is posted.
	let failed = false;
	const transaction = db.transaction.bind(db);
	vi.spyOn(db, "transaction").mockImplementation(((
		fn: (tx: Db) => Promise<unknown>,
	) =>
		transaction(async (tx) => {
			const insert = tx.insert.bind(tx);
			vi.spyOn(tx, "insert").mockImplementation(((table: never) => {
				if (table !== schema.purchaseReceiveRequests || failed)
					return insert(table);
				failed = true;
				throw new Error("Connection lost");
			}) as never);
			return fn(tx as unknown as Db);
		})) as never);
	const once = { key: crypto.randomUUID(), lineId: eachLine, quantity: 2 };
	await expect(receive(db, once)).rejects.toThrow(/Connection lost/);
	expect(await knifeTrail()).toEqual({ receipts: 0, movements: 0, onHand: 0 });
	const first = await receive(db, once);
	expect(await receive(db, once)).toEqual(first);
	expect(await knifeTrail()).toEqual({ receipts: 1, movements: 1, onHand: 2 });
});
