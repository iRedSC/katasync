import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { stockCommitmentEntries } from "#/db/quantity-schema";
import { committedUnits } from "#/inventory/commitments";
import {
	activate,
	channelOrder,
	quantityWorld,
} from "#/inventory/commitments.fixtures";
import { setRecipe } from "#/inventory/recipes";
import { stockPositions } from "#/inventory/stock-position";
import { lineStockEffect } from "#/orders/stock-effects";
import { createProduct, createTestDb } from "#/test/db";

let db: Db;
let world: Awaited<ReturnType<typeof quantityWorld>>;

beforeEach(async () => {
	db = await createTestDb();
	world = await quantityWorld(db);
});

describe("stock effects in legacy mode", () => {
	test("orders still take stock when they sync, and reserve nothing", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 5);
		const { orderId } = await world.ingest(channelOrder());
		expect(await world.onHand(wrench, world.warehouse)).toBe(2);
		expect((await committedUnits(db, [wrench])).get(wrench) ?? 0).toBe(0);
		const effect = await lineStockEffect(db, {
			id: await world.lineId(orderId),
			saleBatchId: null,
		});
		expect(effect).toEqual({ kind: "none" });
		expect((await stockPositions(db, [wrench])).get(wrench)).toMatchObject({
			mode: "legacy",
			net: 2,
		});
	});
});

describe("stock effects once committed", () => {
	beforeEach(async () => {
		await activate(db);
	});

	test("an unshipped order reserves without touching the shelf, once however often it syncs", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 5);
		const { orderId, problems } = await world.ingest(channelOrder());
		await world.ingest(channelOrder());
		expect(problems).toEqual([]);
		expect(await world.onHand(wrench, world.warehouse)).toBe(5);
		expect(await world.available(wrench)).toBe(2);
		expect((await stockPositions(db, [wrench])).get(wrench)).toEqual({
			mode: "committed",
			productId: wrench,
			physical: 5,
			committed: 3,
			available: 2,
			shortage: 0,
			inTransit: 0,
		});
		expect(
			await lineStockEffect(db, {
				id: await world.lineId(orderId),
				saleBatchId: null,
			}),
		).toEqual({ kind: "reserved", remaining: 3, consumed: 0 });
	});

	test("oversold demand comes in as a shortage, not a refusal", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 2);
		const { problems } = await world.ingest(channelOrder());
		expect(problems).toEqual([]);
		expect(await world.available(wrench)).toBe(0);
		expect((await stockPositions(db, [wrench])).get(wrench)).toMatchObject({
			physical: 2,
			committed: 3,
			shortage: 1,
		});
	});

	test("a smaller quantity releases the difference, and cancelling releases the rest once", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 5);
		const line = channelOrder().lines[0];
		await world.ingest(channelOrder());
		await world.ingest(channelOrder({ lines: [{ ...line, quantity: 1 }] }));
		expect((await committedUnits(db, [wrench])).get(wrench)).toBe(1);
		const cancelled = channelOrder({
			cancelledAt: new Date("2026-10-06T00:00:00Z"),
			lines: [{ ...line, quantity: 1 }],
		});
		await world.ingest(cancelled);
		const entries = await db.select().from(stockCommitmentEntries);
		await world.ingest(cancelled);
		expect(await db.select().from(stockCommitmentEntries)).toHaveLength(
			entries.length,
		);
		expect((await committedUnits(db, [wrench])).get(wrench)).toBe(0);
		expect(await world.onHand(wrench, world.warehouse)).toBe(5);
	});

	test("in-store sales take stock at once; channel-fulfilled orders never reserve ours", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.retail, 5);
		await world.ingest(channelOrder({ soldInStore: true }));
		expect(await world.onHand(wrench, world.retail)).toBe(2);
		await world.ingest(
			channelOrder({
				externalId: "fba-1",
				name: "#FBA",
				fulfilledByChannel: true,
			}),
		);
		expect((await committedUnits(db, [wrench])).get(wrench) ?? 0).toBe(0);
		expect(await world.onHand(wrench, world.retail)).toBe(2);
	});

	test("a tool set keeps the parts it was ordered with after its recipe changes", async () => {
		const set = await createProduct(db, "SET", "bundle");
		const blade = await createProduct(db, "BLADE", "simple");
		const handle = await createProduct(db, "HANDLE", "simple");
		const knife = await createProduct(db, "KNIFE", "simple");
		await setRecipe(db, set, [
			{ productId: blade, quantity: 2 },
			{ productId: handle, quantity: 1 },
		]);
		const line = { ...channelOrder().lines[0], sku: "SET", quantity: 1 };
		await world.ingest(channelOrder({ lines: [line] }));
		await setRecipe(db, set, [{ productId: knife, quantity: 1 }]);
		await world.ingest(channelOrder({ lines: [{ ...line, quantity: 2 }] }));
		const committed = await committedUnits(db, [blade, handle, knife]);
		expect(committed.get(blade)).toBe(4);
		expect(committed.get(handle)).toBe(2);
		expect(committed.get(knife) ?? 0).toBe(0);
	});
});
