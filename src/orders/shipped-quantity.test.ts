import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { type ChannelOrder, ingestOrder } from "./ingest";
import { partlyShipped, remainingOf, toPack, unitsToShip } from "./remaining";

// order_lines.shipped_quantity: what the marketplace says already went out
// of each line. Null is unknown, never none.

describe("what's left to ship", () => {
	const line = (quantity: number, shippedQuantity: number | null) => ({
		quantity,
		shippedQuantity,
	});

	test("is the quantity less what shipped, never below none", () => {
		expect(unitsToShip(line(5, 2), "PARTIALLY_FULFILLED")).toBe(3);
		expect(unitsToShip(line(2, 3), "PARTIALLY_FULFILLED")).toBe(0);
	});

	test("an uncounted line is all of it before anything ships, unknown after", () => {
		expect(unitsToShip(line(2, null), "UNFULFILLED")).toBe(2);
		expect(unitsToShip(line(2, null), "AWAITING_PAYMENT")).toBe(2);
		expect(unitsToShip(line(2, null), "PARTIALLY_FULFILLED")).toBeNull();
		expect(
			remainingOf([line(2, 1), line(1, null)], "PARTIALLY_FULFILLED").kind,
		).toBe("unknown");
		// A cancelled line has nothing to know.
		expect(
			remainingOf([line(2, 1), line(0, null)], "PARTIALLY_FULFILLED").kind,
		).toBe("known");
	});

	test("packing leaves out lines with nothing left", () => {
		expect(
			toPack(
				[
					{ id: 1, ...line(5, 2) },
					{ id: 2, ...line(1, 1) },
				],
				"PARTIALLY_FULFILLED",
			),
		).toEqual([{ id: 1, quantity: 3, shippedQuantity: 2 }]);
	});

	test("partly shipped means some went and some didn't", () => {
		expect(partlyShipped([line(5, 2)])).toBe(true);
		expect(partlyShipped([line(1, 1), line(1, 0)])).toBe(true);
		expect(partlyShipped([line(1, 1), line(1, 1)])).toBe(false);
		expect(partlyShipped([line(1, 0), line(1, null)])).toBe(false);
	});
});

describe("ingestOrder", () => {
	const order = (shipped: number | null, extra: Partial<ChannelOrder> = {}) =>
		({
			externalId: "gid://shopify/Order/1",
			name: "#1001",
			salesChannel: "Online Store",
			marketplaceOrderId: null,
			placedAt: new Date("2026-10-05T12:00:00Z"),
			cancelledAt: null,
			fulfillmentStatus: "PARTIALLY_FULFILLED",
			fulfilledByChannel: false,
			soldInStore: false,
			financialStatus: "PAID",
			customerName: null,
			buyerId: null,
			shipCity: null,
			shipRegion: null,
			shipCountry: "US",
			shipAddress1: null,
			shipAddress2: null,
			shipPostalCode: null,
			shipPhone: null,
			total: 50,
			shippingCharged: 0,
			tax: { remittedBy: "seller", lines: [] },
			sourceUpdatedAt: new Date("2026-10-05T12:00:00Z"),
			lines: [
				{
					externalId: "line-1",
					listingExternalId: null,
					sku: "WRENCH",
					title: "Wrench",
					quantity: 3,
					shipped,
					unitPrice: 10,
				},
			],
			...extra,
		}) satisfies ChannelOrder;

	// Stock is left alone: the store takes none (no stockFrom).
	const from = { shipping: null, store: null, pos: null, storeKeeps: 0 };
	let db: Db;
	let store: { id: number; stockFrom: null };
	beforeEach(async () => {
		db = await createTestDb();
		const [row] = await db
			.insert(schema.stores)
			.values({ channel: "shopify", name: "Shopify" })
			.returning();
		await createProduct(db, "WRENCH", "simple");
		store = { id: row.id, stockFrom: null };
	});
	const lineOf = async () => (await db.select().from(schema.orderLines))[0];

	test("saves what shipped, and a later count even when nothing else changed", async () => {
		await ingestOrder(db, store, order(null), from);
		expect((await lineOf()).shippedQuantity).toBeNull();
		await ingestOrder(db, store, order(1), from);
		expect((await lineOf()).shippedQuantity).toBe(1);
		const before = await lineOf();
		await ingestOrder(db, store, order(2), from);
		const after = await lineOf();
		expect(after).toEqual({ ...before, shippedQuantity: 2 });
	});

	test("a count the channel can no longer give goes back to unknown", async () => {
		await ingestOrder(db, store, order(2), from);
		await ingestOrder(db, store, order(null), from);
		expect((await lineOf()).shippedQuantity).toBeNull();
	});

	test("the database refuses a negative count", async () => {
		const { orderId } = await ingestOrder(db, store, order(0), from);
		await expect(
			db
				.update(schema.orderLines)
				.set({ shippedQuantity: -1 })
				.where(eq(schema.orderLines.orderId, orderId)),
		).rejects.toThrow();
	});
});

// drizzle/0180_order_line_shipped.sql, on orders saved before it.
test("upgrading counts open and finished orders, leaving partly shipped ones unknown", async () => {
	const db = await createTestDb({
		beforeMigration: 180,
		seed: async (pg) => {
			await pg.query(
				"INSERT INTO stores (channel, name) VALUES ('shopify', 'Upgrade')",
			);
			const statuses = [
				"UNFULFILLED",
				"ON_HOLD",
				"AWAITING_PAYMENT",
				"FULFILLED",
				"FULFILLMENT_NOT_REQUIRED",
				"PARTIALLY_FULFILLED",
			];
			for (const status of statuses) {
				await pg.query(
					`INSERT INTO orders (store_id, external_id, name, placed_at, fulfillment_status, total, source_updated_at)
					SELECT id, $1, $1, now(), $1, 0, now() FROM stores`,
					[status],
				);
				await pg.query(
					`INSERT INTO order_lines (order_id, external_id, title, quantity, unit_price)
					SELECT id, 'L', 'Line', 3, 1 FROM orders WHERE name = $1`,
					[status],
				);
			}
		},
	});
	const rows = await db
		.select({
			status: schema.orders.fulfillmentStatus,
			shipped: schema.orderLines.shippedQuantity,
		})
		.from(schema.orderLines)
		.innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
		.orderBy(schema.orders.id);
	expect(rows.map((r) => [r.status, r.shipped])).toEqual([
		["UNFULFILLED", 0],
		["ON_HOLD", 0],
		["AWAITING_PAYMENT", 0],
		["FULFILLED", 3],
		["FULFILLMENT_NOT_REQUIRED", 3],
		["PARTIALLY_FULFILLED", null],
	]);
}, 20000);
