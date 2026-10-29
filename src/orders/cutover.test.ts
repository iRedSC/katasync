import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { repairs } from "#/db/repair-schema";
import * as schema from "#/db/schema";
import { activate } from "#/inventory/commitments.fixtures";
import { startBench } from "#/repairs/bench";
import { moveRepair } from "#/repairs/repairs";
import { createProduct, createTestDb } from "#/test/db";
import { listRefundQueue } from "./refund-queue";
import { scanReturn } from "./return-scan";
import { receiveReturn, undoReturns } from "./returns";

// Returns only counted back at cutover can still be checked in, or benched,
// when their box is opened; undoing that counts them back as they were.

let db: Db;
let taper: number;
const counted = new Date("2025-10-15T19:06:50Z");

beforeEach(async () => {
	db = await createTestDb();
	await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" });
	taper = await createProduct(db, "TAPER", "simple");
});

// Sold before katasync took stock, and counted back at cutover.
async function oldReturn() {
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: "gid://shopify/Order/3001",
			name: "#3001",
			placedAt: new Date("2025-09-01"),
			fulfillmentStatus: "FULFILLED",
			total: 1000,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	const [line] = await db
		.insert(schema.orderLines)
		.values({
			orderId: order.id,
			externalId: "line-1",
			productId: taper,
			sku: "TAPER",
			title: "Taper",
			quantity: 1,
			unitPrice: 1000,
			unitCost: 500,
		})
		.returning();
	await db.insert(schema.orderReturns).values({
		orderLineId: line.id,
		quantity: 1,
		restocked: false,
		preCutover: true,
		createdAt: counted,
	});
	return { orderId: order.id, lineId: line.id };
}

const returns = (lineId: number) =>
	db
		.select()
		.from(schema.orderReturns)
		.where(eq(schema.orderReturns.orderLineId, lineId));

async function onHand() {
	const [row] = await db
		.select({
			n: sql<number>`coalesce(sum(${schema.stockLevels.onHand}), 0)::int`,
		})
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, taper));
	return row.n;
}

describe("a return counted back at cutover", () => {
	test("scans as still to check in", async () => {
		await oldReturn();
		const [found] = await scanReturn(db, "#3001");
		expect(found.lines).toMatchObject([{ left: 1, counted: 1 }]);
		expect(found.blocker).toBeNull();
	});

	test("with committed stock, sold before cutover, it can still be checked in", async () => {
		const o = await oldReturn();
		await db.update(schema.stores).set({ stockFrom: new Date("2025-10-01") });
		await activate(db);
		const [found] = await scanReturn(db, "#3001");
		expect(found.lines).toMatchObject([{ left: 1, counted: 1 }]);
		expect(found.blocker).toBeNull();
		await receiveReturn(db, {
			orderId: o.orderId,
			lines: [{ lineId: o.lineId, quantity: 1 }],
			outcome: "write_off",
		});
		expect(await returns(o.lineId)).toMatchObject([
			{ preCutover: false, cutoverQuantity: 1 },
		]);
	});

	test("checked in, it goes on the shelf and to Refunds; undone, it's counted back", async () => {
		const o = await oldReturn();
		const { ids } = await receiveReturn(db, {
			orderId: o.orderId,
			lines: [{ lineId: o.lineId, quantity: 1 }],
			outcome: "restock",
			note: "Box crushed, tool fine",
		});
		expect(await returns(o.lineId)).toMatchObject([
			{
				preCutover: false,
				restocked: true,
				cutoverQuantity: 1,
				cutoverAt: counted,
			},
		]);
		expect(await onHand()).toBe(1);
		expect((await listRefundQueue(db)).map((r) => r.name)).toEqual(["#3001"]);
		await expect(
			receiveReturn(db, {
				orderId: o.orderId,
				lines: [{ lineId: o.lineId, quantity: 1 }],
				outcome: "restock",
			}),
		).rejects.toThrow(/already returned/);

		await undoReturns(db, ids);
		expect(await returns(o.lineId)).toMatchObject([
			{ preCutover: true, quantity: 1, createdAt: counted },
		]);
		expect(await onHand()).toBe(0);
		expect(await listRefundQueue(db)).toEqual([]);
	});

	test("benched, cancelling counts it back; back on the board takes it again", async () => {
		const o = await oldReturn();
		const [id] = await startBench(db, { ...o, quantity: 1 });
		expect(await returns(o.lineId)).toEqual([]);
		const job = async () =>
			(await db.select().from(repairs).where(eq(repairs.id, id)))[0];
		expect((await job()).cutoverAt).toEqual(counted);

		await moveRepair(db, id, "cancelled");
		expect(await returns(o.lineId)).toMatchObject([
			{ preCutover: true, quantity: 1, createdAt: counted },
		]);
		await moveRepair(db, id, "received");
		expect(await returns(o.lineId)).toEqual([]);
		expect((await job()).cutoverAt).toEqual(counted);
	});
});
