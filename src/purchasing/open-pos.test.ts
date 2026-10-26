import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import { openPosOf } from "./open-pos";
import { receive } from "./orders";
import { createPurchasingDb, now } from "./purchasing.fixtures";

let db: Db;
let warehouse: number;
let canam: number;

beforeEach(async () => {
	({ db, warehouse, canam } = await createPurchasingDb());
});

async function po(
	status: "suggested" | "draft" | "sent" | "closed" | "cancelled",
	productId: number,
	quantity: number,
	packSize = 1,
	supplierId = canam,
) {
	const [order] = await db
		.insert(schema.purchaseOrders)
		.values({
			supplierId,
			locationId: warehouse,
			status,
			sentAt: status === "draft" || status === "suggested" ? null : now,
			expectedAt: status === "sent" ? now : null,
		})
		.returning();
	const [line] = await db
		.insert(schema.purchaseOrderLines)
		.values({
			purchaseOrderId: order.id,
			productId,
			quantity,
			packSize,
			supplierCount: packSize,
			minimumQuantity: 1,
		})
		.returning();
	return { id: order.id, lineId: line.id };
}

test("lists drafts and what sent POs still owe, in single items", async () => {
	const blade = await createProduct(db, "BLADE", "simple");
	const draft = await po("draft", blade, 2, 12);
	const sent = await po("sent", blade, 10);
	await receive(db, { lineId: sent.lineId, quantity: 4 });
	// One draft or suggested PO per supplier, so another supplier's.
	const [{ id: other }] = await db
		.insert(schema.suppliers)
		.values({ code: "OTHER", name: "Other", leadTimeDays: 10 })
		.returning();
	await po("suggested", blade, 5, 1, other);
	await po("closed", blade, 5);
	await po("cancelled", blade, 5);
	const done = await po("sent", blade, 3);
	await receive(db, { lineId: done.lineId, quantity: 3 });

	expect((await openPosOf(db, [blade])).get(blade)).toEqual([
		{
			purchaseOrderId: draft.id,
			status: "draft",
			supplierName: "CanAm",
			units: 24,
			expectedAt: null,
			backOrdered: false,
		},
		{
			purchaseOrderId: sent.id,
			status: "sent",
			supplierName: "CanAm",
			units: 6,
			expectedAt: now,
			backOrdered: false,
		},
	]);
	expect(await openPosOf(db, [])).toEqual(new Map());
});
