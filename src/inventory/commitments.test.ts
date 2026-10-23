import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { addDispatch, createProduct, createTestDb } from "#/test/db";
import { committedUnits, readQuantityMode } from "./commitments";
import {
	ActivationBlocked,
	activateCommittedMode,
	planActivation,
} from "./commitments-activation";
import { consumeCommitments } from "./commitments-consume";
import { restoreCommitments } from "./commitments-restore";
import { activate, channelOrder, quantityWorld } from "./commitments.fixtures";

let db: Db;
let world: Awaited<ReturnType<typeof quantityWorld>>;

beforeEach(async () => {
	db = await createTestDb();
	world = await quantityWorld(db);
});

async function demand(productId: number) {
	const result = (await db.execute(
		sql`select coalesce(sum(units), 0)::int as n from sales_units where product_id = ${productId}`,
	)) as unknown as { rows: { n: number }[] };
	return Number(result.rows[0].n);
}

const committed = async (productId: number) =>
	(await committedUnits(db, [productId])).get(productId) ?? 0;

describe("consuming reservations at dispatch", () => {
	test("in legacy mode a dispatch changes nothing", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 5);
		const { orderId } = await world.ingest(channelOrder());
		const lines = [{ orderLineId: await world.lineId(orderId), quantity: 3 }];
		expect(
			await consumeCommitments(db, { orderId, lines, fulfillmentKey: "d1" }),
		).toEqual({ kind: "legacy" });
		expect(await world.onHand(wrench, world.warehouse)).toBe(2);
	});

	test("a partial dispatch takes exactly what shipped, once per fulfillment", async () => {
		await activate(db);
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 5);
		const { orderId } = await world.ingest(channelOrder());
		const orderLineId = await world.lineId(orderId);
		await addDispatch(db, { orderIds: [orderId] });
		expect(await world.onHand(wrench, world.warehouse)).toBe(5);
		expect(await committed(wrench)).toBe(3);

		const first = { orderId, lines: [{ orderLineId, quantity: 1 }], fulfillmentKey: "d1" };
		expect(await consumeCommitments(db, first)).toMatchObject({
			kind: "consumed",
			lines: [{ orderLineId, quantity: 1, repeated: false }],
		});
		expect(await consumeCommitments(db, first)).toMatchObject({
			lines: [{ repeated: true }],
		});
		await expect(
			consumeCommitments(db, { ...first, lines: [{ orderLineId, quantity: 2 }] }),
		).rejects.toThrow("already shipped 1");
		expect(await world.onHand(wrench, world.warehouse)).toBe(4);
		expect(await committed(wrench)).toBe(2);
		expect(await world.available(wrench)).toBe(2);

		await expect(
			consumeCommitments(db, {
				orderId,
				lines: [{ orderLineId, quantity: 3 }],
				fulfillmentKey: "d2",
			}),
		).rejects.toThrow("has 2 reserved");
		await consumeCommitments(db, {
			orderId,
			lines: [{ orderLineId, quantity: 2 }],
			fulfillmentKey: "d2",
		});
		expect(await world.onHand(wrench, world.warehouse)).toBe(2);
		expect(await committed(wrench)).toBe(0);
	});

	test("what the warehouse lacks comes off the store above its reserve", async () => {
		await activate(db);
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 1);
		await world.stock(wrench, world.retail, 5);
		const { orderId } = await world.ingest(channelOrder());
		await consumeCommitments(db, {
			orderId,
			lines: [{ orderLineId: await world.lineId(orderId), quantity: 3 }],
			fulfillmentKey: "d1",
		});
		expect(await world.onHand(wrench, world.warehouse)).toBe(0);
		expect(await world.onHand(wrench, world.retail)).toBe(3);
	});

	test("voiding a dispatch puts its units back on the shelf and back on reserve", async () => {
		await activate(db);
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 5);
		const { orderId } = await world.ingest(channelOrder());
		const orderLineId = await world.lineId(orderId);
		const shipped = { orderId, lines: [{ orderLineId, quantity: 2 }], fulfillmentKey: "d1" };
		await consumeCommitments(db, shipped);
		await restoreCommitments(db, { orderId, fulfillmentKey: "d1" });
		expect(await restoreCommitments(db, { orderId, fulfillmentKey: "d1" })).toEqual({
			kind: "restored",
			lines: [],
			voidedUnreserved: [],
		});
		expect(await world.onHand(wrench, world.warehouse)).toBe(5);
		expect(await committed(wrench)).toBe(3);
		await expect(consumeCommitments(db, shipped)).rejects.toThrow("was voided");
	});
});

describe("activation", () => {
	test("open eager sales become reservations without doubling demand or moving costs", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await db.update(schema.products).set({ unitCost: 4 }).where(eq(schema.products.id, wrench));
		await world.stock(wrench, world.warehouse, 10);
		await world.stock(wrench, world.retail, 4);
		await world.ingest(channelOrder());
		await world.ingest(
			channelOrder({ externalId: "shipped", name: "#1002", fulfillmentStatus: "FULFILLED" }),
		);
		await world.ingest(channelOrder({ externalId: "pos", name: "#1003", soldInStore: true }));
		const before = {
			warehouse: await world.onHand(wrench, world.warehouse),
			available: await world.available(wrench),
			demand: await demand(wrench),
			costs: await db.select({ unitCost: schema.orderLines.unitCost }).from(schema.orderLines),
		};
		expect(before.warehouse).toBe(4);

		const plan = await planActivation(db);
		expect(plan.convert).toHaveLength(1);
		expect(plan.keep).toEqual({ pos: 1, shipped: 1 });
		await activate(db);

		expect(await readQuantityMode(db, "none")).toBe("committed");
		expect(await world.onHand(wrench, world.warehouse)).toBe(7);
		expect(await committed(wrench)).toBe(3);
		expect(await world.available(wrench)).toBe(before.available);
		expect(await demand(wrench)).toBe(before.demand);
		expect(
			await db.select({ unitCost: schema.orderLines.unitCost }).from(schema.orderLines),
		).toEqual(before.costs);
		await expect(activate(db)).rejects.toThrow("already active");
	});

	test("a label on an order the channel calls unshipped blocks until someone says what shipped", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.stock(wrench, world.warehouse, 5);
		const { orderId } = await world.ingest(channelOrder());
		await world.ingest(
			channelOrder({ externalId: "partial", name: "#1004", fulfillmentStatus: "PARTIALLY_FULFILLED" }),
		);
		await addDispatch(db, { orderIds: [orderId] });
		const plan = await planActivation(db);
		expect(plan.unresolved.map((u) => u.why).sort()).toEqual([
			"label_without_shipped_status",
			"partially_fulfilled",
		]);
		await expect(
			activateCommittedMode(db, {
				fingerprint: plan.fingerprint,
				oldWorkersDrained: true,
			}),
		).rejects.toBeInstanceOf(ActivationBlocked);
		expect(await readQuantityMode(db, "none")).toBe("legacy");
		expect(await world.onHand(wrench, world.warehouse)).toBe(-1);

		const [labelled, partial] = plan.unresolved.sort((a, b) => a.orderLineId - b.orderLineId);
		const resolutions = [
			{ orderLineId: labelled.orderLineId, shipped: 1 },
			{ orderLineId: partial.orderLineId, shipped: 3 },
		];
		await expect(
			activateCommittedMode(db, { fingerprint: "stale", resolutions, oldWorkersDrained: true }),
		).rejects.toThrow("plan changed");
		await activate(db, resolutions);
		expect(await world.onHand(wrench, world.warehouse)).toBe(1);
		expect(await committed(wrench)).toBe(2);
	});
});
