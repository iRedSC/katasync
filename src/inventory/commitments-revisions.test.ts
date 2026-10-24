import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { stockCommitmentEntries } from "#/db/quantity-schema";
import * as schema from "#/db/schema";
import { takeStock } from "#/orders/ingest";
import { reconcileStock } from "#/orders/reconcile-stock";
import { lineStockEffect } from "#/orders/stock-effects";
import { createProduct, createTestDb } from "#/test/db";
import { committedUnits } from "./commitments";
import { activate, channelOrder, quantityWorld } from "./commitments.fixtures";
import {
	ConsumeError,
	consumeCommitments,
	returnSaleOf,
} from "./commitments-consume";
import { restoreCommitments } from "./commitments-restore";

let db: Db;
let world: Awaited<ReturnType<typeof quantityWorld>>;
let wrench: number;

const line = channelOrder().lines[0];
const sized = (quantity: number) =>
	channelOrder({ lines: [{ ...line, quantity }] });
const committed = async () =>
	(await committedUnits(db, [wrench])).get(wrench) ?? 0;
const shelf = () => world.onHand(wrench, world.warehouse);

async function ship(orderId: number, quantity: number, fulfillmentKey: string) {
	return consumeCommitments(db, {
		orderId,
		lines: [{ orderLineId: await world.lineId(orderId), quantity }],
		fulfillmentKey,
	});
}

beforeEach(async () => {
	db = await createTestDb();
	world = await quantityWorld(db);
});

describe("revisions keep what shipped", () => {
	beforeEach(async () => {
		await activate(db);
		wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 10);
	});

	test("a bigger order after a partial ship reserves only what's left; a smaller one never unships", async () => {
		const { orderId } = await world.ingest(sized(3));
		await ship(orderId, 2, "d1");
		await world.ingest(sized(4));
		expect(await committed()).toBe(2);
		expect(await shelf()).toBe(8);
		const { problems } = await world.ingest(sized(1));
		expect(problems).toEqual([
			"#1001: 2 already shipped, more than the 1 ordered now",
		]);
		expect(await committed()).toBe(0);
		const entries = await db.select().from(stockCommitmentEntries);
		await world.ingest(sized(1));
		expect(await db.select().from(stockCommitmentEntries)).toHaveLength(
			entries.length,
		);
		expect(await shelf()).toBe(8);
	});

	test("a void after a quantity edit restores the exact revision it shipped from", async () => {
		const { orderId } = await world.ingest(sized(3));
		await ship(orderId, 2, "d1");
		await world.ingest(sized(4));
		await restoreCommitments(db, { orderId, fulfillmentKey: "d1" });
		expect(await shelf()).toBe(10);
		expect(await committed()).toBe(4);
		await ship(orderId, 4, "d2");
		expect(await shelf()).toBe(6);
		expect(await committed()).toBe(0);
		expect(await returnSaleOf(db, await world.lineId(orderId))).toMatchObject({
			quantity: 4,
		});
	});

	test("a void after the order shrank below what shipped reserves only the new quantity", async () => {
		const { orderId } = await world.ingest(sized(3));
		await ship(orderId, 2, "d1");
		await world.ingest(sized(1));
		await restoreCommitments(db, { orderId, fulfillmentKey: "d1" });
		expect(await shelf()).toBe(10);
		expect(await committed()).toBe(1);
	});

	test("a void after cancelling puts the units back without reserving them", async () => {
		const { orderId } = await world.ingest(sized(3));
		await ship(orderId, 2, "d1");
		await world.ingest(
			channelOrder({
				cancelledAt: new Date("2026-10-07T00:00:00Z"),
				lines: [{ ...line, quantity: 3 }],
			}),
		);
		expect(await committed()).toBe(0);
		await restoreCommitments(db, { orderId, fulfillmentKey: "d1" });
		expect(await shelf()).toBe(10);
		expect(await committed()).toBe(0);
		await expect(ship(orderId, 2, "d1")).rejects.toBeInstanceOf(ConsumeError);
	});
});

describe("lines that shipped before they had a product", () => {
	const unknown = channelOrder({
		lines: [{ ...line, sku: "NEWTOOL", quantity: 3 }],
	});

	async function mapLater(orderId: number) {
		wrench = await createProduct(db, "NEWTOOL", "simple");
		await world.stock(wrench, world.warehouse, 10);
		const orderLineId = await world.lineId(orderId);
		const [row] = await db
			.update(schema.orderLines)
			.set({ productId: wrench })
			.where(eq(schema.orderLines.id, orderLineId))
			.returning();
		return takeStock(
			db,
			{ ...row, productId: wrench },
			{ name: "#1001", soldInStore: false },
			world.from,
		);
	}

	beforeEach(async () => {
		await activate(db);
	});

	test("its shipment is kept, so mapping it takes the units instead of reserving them", async () => {
		const { orderId, problems } = await world.ingest(unknown);
		expect(problems).toEqual(["#1001: no product for NEWTOOL"]);
		expect(await ship(orderId, 3, "d1")).toMatchObject({
			untracked: [{ why: "shipped_unreserved", repeated: false }],
		});
		expect(await ship(orderId, 3, "d1")).toMatchObject({
			untracked: [{ repeated: true }],
		});
		const orderLineId = await world.lineId(orderId);
		expect(
			await lineStockEffect(db, { id: orderLineId, saleBatchId: null }),
		).toEqual({
			kind: "shipped_unreserved",
			shipped: 3,
		});
		expect(await mapLater(orderId)).toBeNull();
		expect(await shelf()).toBe(7);
		expect(await committed()).toBe(0);
		expect(
			await lineStockEffect(db, { id: orderLineId, saleBatchId: null }),
		).toEqual({
			kind: "released",
			consumed: 3,
		});
		await world.ingest(unknown);
		expect(await shelf()).toBe(7);
		expect(await committed()).toBe(0);
	});

	test("a void before mapping leaves it to reserve like any unshipped line", async () => {
		const { orderId } = await world.ingest(unknown);
		await ship(orderId, 3, "d1");
		expect(
			await restoreCommitments(db, { orderId, fulfillmentKey: "d1" }),
		).toMatchObject({
			voidedUnreserved: [{ quantity: 3 }],
		});
		await mapLater(orderId);
		expect(await shelf()).toBe(10);
		expect(await committed()).toBe(3);
		await expect(ship(orderId, 3, "d1")).rejects.toThrow("was voided");
	});

	test.each([
		"cancelled",
		"zero",
	])("mapping a shipped %s line still deducts its proven shipment", async (kind) => {
		const { orderId } = await world.ingest(unknown);
		await ship(orderId, 3, "d1");
		await world.ingest({
			...unknown,
			...(kind === "cancelled"
				? { cancelledAt: new Date() }
				: { lines: [{ ...unknown.lines[0], quantity: 0 }] }),
		});
		wrench = await createProduct(db, "NEWTOOL", "simple");
		await world.stock(wrench, world.warehouse, 10);
		await db
			.update(schema.orderLines)
			.set({ productId: wrench })
			.where(eq(schema.orderLines.id, await world.lineId(orderId)));
		await reconcileStock(db, world.from);
		expect(await shelf()).toBe(7);
		expect(await committed()).toBe(0);
		await reconcileStock(db, world.from);
		await world.ingest({ ...unknown, cancelledAt: new Date() });
		expect(await shelf()).toBe(7);
		expect(await committed()).toBe(0);
	});
});

describe("lines activation kept as shipped", () => {
	test("later edits and cancels never reserve or restock them", async () => {
		wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 10);
		const shipped = (extra: Parameters<typeof channelOrder>[0]) =>
			world.ingest(channelOrder({ fulfillmentStatus: "FULFILLED", ...extra }));
		await shipped({});
		await activate(db);
		const resized = await shipped({ lines: [{ ...line, quantity: 1 }] });
		expect(resized.problems).toEqual([
			"#1001: Wrench shipped before committed stock; it now says 1, so record a return or count instead",
		]);
		const cancel = {
			cancelledAt: new Date("2026-10-08T00:00:00Z"),
			lines: [{ ...line, quantity: 1 }],
		};
		expect((await shipped(cancel)).problems).toEqual([
			"#1001: Wrench was cancelled after it shipped; record a return if it comes back",
		]);
		expect((await shipped(cancel)).problems).toEqual([]);
		expect(await shelf()).toBe(7);
		expect(await committed()).toBe(0);
	});
});
