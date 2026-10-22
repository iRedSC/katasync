import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	receive,
	receiveAll,
	receivedOf,
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
	await receive(db, { lineId: eachLine, quantity: 2 });
	await setBackOrdered(db, { lineId: lateLine, backOrdered: true });
	const { receipts, closed } = await receiveAll(db, poId);
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
	await receive(db, { lineId: eachLine, quantity: 2 });
	const { receipts, closed } = await receiveAll(db, poId);
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
	await receiveAll(db, poId);
	await expect(receiveAll(db, poId)).rejects.toThrow();
});
