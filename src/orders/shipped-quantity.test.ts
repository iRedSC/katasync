import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { type ChannelOrder, ingestOrder } from "./ingest";
import {
	BEHIND_REMAINING,
	packableOf,
	partlyShipped,
	remainingOf,
	shippedOf,
	toPack,
	toPrint,
	whyNotPackable,
} from "./remaining";

// order_lines.shipped_quantity: what the marketplace says already went out
// of each line. Null is unknown, never none.

describe("what's left to ship", () => {
	// handedOff and unsent are katasync's own dispatches (see remaining.ts).
	const line = (
		quantity: number,
		shippedQuantity: number | null,
		handedOff = 0,
		unsent = 0,
	) => ({ quantity, shippedQuantity, handedOff, unsent });
	const units = (l: ReturnType<typeof line>) => {
		const p = packableOf(l);
		return p.kind === "known" ? p.units : p.kind;
	};

	test("is the quantity less what shipped, never below none", () => {
		expect(units(line(5, 2))).toBe(3);
		expect(units(line(2, 3))).toBe(0);
		expect(units(line(2, 0))).toBe(2);
	});

	test("an uncounted line is unknown, whatever the order's status says", () => {
		// katasync rewrites the status locally (a void puts it back to
		// UNFULFILLED), so it can't stand in for the marketplace's count.
		expect(units(line(2, null))).toBe("unknown");
		expect(toPack([line(2, null)]).kind).toBe("unknown");
		expect(remainingOf([line(2, 1), line(1, null)]).kind).toBe("unknown");
		// A cancelled line has nothing to know.
		expect(remainingOf([line(2, 1), line(0, null)]).kind).toBe("known");
	});

	test("units in a live dispatch not yet handed off aren't packable again", () => {
		expect(units(line(5, 0, 0, 2))).toBe(3);
		expect(units(line(5, 0, 0, 5))).toBe(0);
		// Shipped by the marketplace and held by us together.
		expect(units(line(5, 2, 0, 2))).toBe(1);
	});

	test("a count that covers our own handoff is trusted", () => {
		// Handed off 2, and the marketplace now says 2 (or more, from its own
		// admin) shipped.
		expect(units(line(5, 2, 2))).toBe(3);
		expect(units(line(5, 3, 2))).toBe(2);
	});

	test("a count from before our own handoff has to wait for the next sync", () => {
		// Handed off 2, but the marketplace's snapshot still says none: taking
		// it at its word would pack those 2 again.
		expect(units(line(5, 0, 2))).toBe("behind");
		expect(remainingOf([line(5, 0, 2), line(1, 0)]).kind).toBe("behind");
		expect(toPack([line(5, 0, 2)]).kind).toBe("behind");
		// Unknown still wins: that one may need a person.
		expect(remainingOf([line(5, 0, 2), line(1, null)]).kind).toBe("unknown");
		expect(whyNotPackable("behind")).toBe(BEHIND_REMAINING);
	});

	test("packing leaves out lines with nothing left", () => {
		expect(
			toPack([
				{ id: 1, ...line(5, 2) },
				{ id: 2, ...line(1, 1) },
			]),
		).toEqual({
			kind: "known",
			lines: [
				{ id: 1, quantity: 3, shippedQuantity: 2, handedOff: 0, unsent: 0 },
			],
		});
	});

	test("the packing slip prints what's packable only while the order still needs packing", () => {
		const lines = [line(5, 2), line(1, 1), line(4, 0, 0, 1)];
		const printed = (needsPacking: boolean) =>
			toPrint(lines, { needsPacking }).map((l) => [l.toPack, l.quantity]);
		expect(printed(true)).toEqual([
			[3, 5],
			[0, 1],
			[3, 4],
		]);
		// A reprint of a finished order shows what was sold, as it went out.
		expect(printed(false)).toEqual([
			[5, 5],
			[1, 1],
			[4, 4],
		]);
		// Unknown, or behind, prints what was sold too; quick ship refuses
		// packing it.
		expect(
			toPrint([line(5, null)], { needsPacking: true }).map((l) => l.toPack),
		).toEqual([5]);
		expect(
			toPrint([line(5, 0, 2)], { needsPacking: true }).map((l) => l.toPack),
		).toEqual([5]);
	});

	test("partly shipped means some went and some didn't, as far as is known", () => {
		expect(partlyShipped([line(5, 2)])).toBe(true);
		expect(partlyShipped([line(1, 1), line(1, 0)])).toBe(true);
		expect(partlyShipped([line(1, 1), line(1, 1)])).toBe(false);
		expect(partlyShipped([line(1, 0), line(1, null)])).toBe(false);
		// An unknown line is neither shipped nor still to ship.
		expect(partlyShipped([line(1, 1), line(1, null)])).toBe(false);
		expect(partlyShipped([line(2, null)])).toBe(false);
		expect(partlyShipped([line(5, 2), line(1, null)])).toBe(true);
	});

	test("shipped of a line is its count, at most its quantity, or unknown", () => {
		expect(shippedOf(line(5, 2))).toBe(2);
		expect(shippedOf(line(2, 3))).toBe(2);
		expect(shippedOf(line(2, 0))).toBe(0);
		expect(shippedOf(line(2, null))).toBeNull();
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
test("upgrading counts unshipped and finished orders, leaving any that may hide shipped units unknown", async () => {
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
				"SCHEDULED",
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
		["ON_HOLD", null],
		["AWAITING_PAYMENT", 0],
		["FULFILLED", 3],
		["FULFILLMENT_NOT_REQUIRED", 3],
		["PARTIALLY_FULFILLED", null],
		["SCHEDULED", null],
	]);
}, 20000);
