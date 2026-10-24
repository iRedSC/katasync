import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { committedUnits } from "#/inventory/commitments";
import {
	activate,
	channelOrder,
	quantityWorld,
} from "#/inventory/commitments.fixtures";
import { fromStore } from "#/orders/from-store";
import { receiveReturn, undoReturns } from "#/orders/returns";
import { createProduct, createTestDb } from "#/test/db";
import { memoryLocker } from "./dispatch";
import { addPackedDispatch } from "./dispatch.fixtures";
import { type Outside, sendTracking, voidDispatch } from "./handoff";

let db: Db;
let world: Awaited<ReturnType<typeof quantityWorld>>;
let wrench: number;
let orderId: number;

beforeEach(async () => {
	vi.stubEnv("TRACKING_LINK_SECRET", "test-tracking-secret");
	vi.stubEnv("STOREFRONT_ORIGIN", "https://storefront.example.com");
	db = await createTestDb();
	world = await quantityWorld(db);
	await activate(db);
	wrench = await createProduct(db, "WRENCH", "simple");
	await world.stock(wrench, world.warehouse, 5);
	({ orderId } = await world.ingest(channelOrder()));
});

afterEach(() => vi.unstubAllEnvs());

function outside(): Outside {
	return {
		lock: memoryLocker(),
		shopifyFulfill: vi.fn(async () => ({
			fulfillmentId: "fulfillment-1",
			remaining: 0,
		})),
		shopifyCancel: vi.fn(async () => {}),
		shopifySaveTracking: vi.fn(async () => {}),
		shopifyRemoveTracking: vi.fn(async () => {}),
		ebayShip: vi.fn(async () => ({ fulfillmentId: "ebay-1", remaining: 0 })),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		tiktokShip: vi.fn(),
		tiktokUnits: vi.fn(),
	};
}

const reserved = async () =>
	(await committedUnits(db, [wrench])).get(wrench) ?? 0;

test("a purchased label cannot authorize a return before consumption", async () => {
	await addPackedDispatch(db, { orderIds: [orderId] });
	await expect(
		receiveReturn(db, {
			orderId,
			lines: [{ lineId: await world.lineId(orderId), quantity: 1 }],
			outcome: "restock",
		}),
	).rejects.toThrow(/already returned|Only 0/);
	expect(await world.onHand(wrench, world.warehouse)).toBe(5);
	expect(await reserved()).toBe(3);
});

test("shipped units can return after cancellation; their return blocks void until undone", async () => {
	const { dispatchId } = await addPackedDispatch(db, { orderIds: [orderId] });
	const api = outside();
	await sendTracking(db, dispatchId, api);
	await world.ingest(
		channelOrder({ cancelledAt: new Date(), fulfillmentStatus: "FULFILLED" }),
	);
	const returned = await receiveReturn(db, {
		orderId,
		lines: [{ lineId: await world.lineId(orderId), quantity: 3 }],
		outcome: "restock",
	});
	expect(await world.onHand(wrench, world.warehouse)).toBe(5);
	await expect(voidDispatch(db, dispatchId, api)).rejects.toThrow(
		"Undo the received returns",
	);
	expect(api.shopifyCancel).not.toHaveBeenCalled();
	expect(api.refund).not.toHaveBeenCalled();
	expect(await world.onHand(wrench, world.warehouse)).toBe(5);
	await undoReturns(db, returned.ids);
	await voidDispatch(db, dispatchId, api);
	expect(await world.onHand(wrench, world.warehouse)).toBe(5);
	expect(await reserved()).toBe(0);
});

test("old packed evidence without an inventory line identity is held before any marketplace write", async () => {
	const { dispatchId } = await addPackedDispatch(db, {
		orderIds: [orderId],
		legacyLineIdentity: true,
	});
	const api = outside();
	await sendTracking(db, dispatchId, api);
	expect(api.shopifyFulfill).not.toHaveBeenCalled();
	expect(await world.onHand(wrench, world.warehouse)).toBe(5);
	expect(await reserved()).toBe(3);
	expect((await db.select().from(schema.dispatchOrders))[0]).toMatchObject({
		channelSentAt: null,
		handoffHold: { kind: "unmappable" },
	});
});

test("buying a label keeps the reservation; exact handoff consumes once and a verified reversal restores it", async () => {
	const { dispatchId } = await addPackedDispatch(db, { orderIds: [orderId] });
	expect(await reserved()).toBe(3);
	expect(await world.onHand(wrench, world.warehouse)).toBe(5);
	expect(await db.select({ fromStore }).from(schema.orderLines)).toEqual([
		{ fromStore: null },
	]);
	const api = outside();
	await sendTracking(db, dispatchId, api);
	expect(api.shopifyFulfill).toHaveBeenCalledOnce();
	expect(await world.onHand(wrench, world.warehouse)).toBe(2);
	expect(await reserved()).toBe(0);
	expect(await world.available(wrench)).toBe(2);
	await sendTracking(db, dispatchId, api);
	expect(await world.onHand(wrench, world.warehouse)).toBe(2);
	expect(api.shopifyFulfill).toHaveBeenCalledOnce();
	await voidDispatch(db, dispatchId, api);
	expect(api.shopifyCancel).toHaveBeenCalledOnce();
	expect(await world.onHand(wrench, world.warehouse)).toBe(5);
	expect(await reserved()).toBe(3);
	expect(await world.available(wrench)).toBe(2);
});

test("failed marketplace reversal does not restore physical stock", async () => {
	const { dispatchId } = await addPackedDispatch(db, { orderIds: [orderId] });
	const api = outside();
	await sendTracking(db, dispatchId, api);
	api.shopifyCancel = vi.fn(async () => {
		throw new Error("provider unavailable");
	});
	await voidDispatch(db, dispatchId, api);
	expect(await world.onHand(wrench, world.warehouse)).toBe(2);
	expect(await reserved()).toBe(0);
	expect(
		(
			await db
				.select()
				.from(schema.dispatchOrders)
				.where(eq(schema.dispatchOrders.dispatchId, dispatchId))
		)[0].reversedAt,
	).toBeNull();
});

test("accepted tracking with a failed stock write remains durable and retries the same dispatch", async () => {
	const { dispatchId } = await addPackedDispatch(db, { orderIds: [orderId] });
	await db.execute(
		sql`create function test_reject_consumption() returns trigger language plpgsql as $$ begin raise exception 'stock write unavailable'; end; $$`,
	);
	await db.execute(
		sql`create trigger test_reject_consumption before insert on stock_commitment_entries for each row execute function test_reject_consumption()`,
	);
	const api = outside();
	await sendTracking(db, dispatchId, api);
	const [held] = await db.select().from(schema.dispatchOrders);
	expect(held.channelSentAt).toBeNull();
	expect(held.channelRetryAt).not.toBeNull();
	expect(held.channelError).toContain("inventory recording failed");
	expect(await reserved()).toBe(3);
	await db.execute(
		sql`drop trigger test_reject_consumption on stock_commitment_entries`,
	);
	await db.execute(sql`drop function test_reject_consumption()`);
	await sendTracking(db, dispatchId, api);
	expect(await world.onHand(wrench, world.warehouse)).toBe(2);
	expect(await reserved()).toBe(0);
});
