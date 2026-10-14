import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { labelToVoid } from "#/orders/to-ship";
import { addDispatch, createTestDb } from "#/test/db";
import { memoryLocker } from "./dispatch";
import { type Outside, sendTracking, voidDispatch } from "./handoff";
import { assignOrderPins } from "./pins";

let db: Db;
let storeId: number;
let orderId: number;

function fakes(overrides: Partial<Outside> = {}): Outside {
	return {
		lock: memoryLocker(),
		shopifyFulfill: vi.fn(async () => "gid://shopify/Fulfillment/1"),
		shopifyCancel: vi.fn(async () => {}),
		ebayFulfill: vi.fn(async () => "ebay-f-1"),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		tiktokShip: vi.fn(async (id: string) => ({ id, trackingNumber: "TT1" })),
		...overrides,
	};
}

async function addOrder(name: string, channel: "shopify" | "ebay") {
	const [row] = await db
		.insert(schema.orders)
		.values({
			storeId,
			externalId: channel === "shopify" ? `gid://shopify/Order/${name}` : name,
			name,
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 30,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	await db.insert(schema.orderLines).values({
		orderId: row.id,
		externalId: `line-${name}`,
		sku: "WRENCH",
		title: "Wrench",
		quantity: 2,
		unitPrice: 15,
	});
	return row.id;
}

async function setUp(channel: "shopify" | "ebay") {
	db = await createTestDb();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel, name: channel })
		.returning();
	orderId = await addOrder("9", channel);
	await assignOrderPins(db);
}

// One box for the order by default.
const ship = (
	boxes?: Partial<typeof schema.shipments.$inferInsert>[],
	orderIds = [orderId],
) => addDispatch(db, { orderIds, boxes }).then((d) => d.dispatchId);

const orderRow = async (id = orderId) =>
	(await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];
const handoffOf = async (dispatchId: number, id = orderId) =>
	(
		await db
			.select()
			.from(schema.dispatchOrders)
			.where(
				and(
					eq(schema.dispatchOrders.dispatchId, dispatchId),
					eq(schema.dispatchOrders.orderId, id),
				),
			)
	)[0];
const boxesOf = (dispatchId: number) =>
	db
		.select()
		.from(schema.shipments)
		.where(eq(schema.shipments.dispatchId, dispatchId))
		.orderBy(schema.shipments.id);

describe("sendTracking", () => {
	beforeEach(() => setUp("shopify"));

	test("a TikTok label is marked ready on TikTok, which has the tracking", async () => {
		const outside = fakes();
		const id = await ship([
			{
				provider: "tiktok",
				externalId: "1157817232461763469",
				trackingNumber: null,
			},
		]);
		const result = await sendTracking(db, id, outside);

		expect(result.sent).toBe(true);
		expect(outside.tiktokShip).toHaveBeenCalledWith("1157817232461763469");
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
		expect((await boxesOf(id))[0].trackingNumber).toBe("TT1");
		expect((await handoffOf(id)).channelFulfillmentId).toBe(
			"1157817232461763469",
		);
		expect((await orderRow()).fulfillmentStatus).toBe("FULFILLED");
	});

	test("a TikTok label can't be voided from here", async () => {
		const outside = fakes();
		const id = await ship([{ provider: "tiktok", externalId: "115" }]);
		await expect(voidDispatch(db, id, outside)).rejects.toThrow(
			"Seller Center",
		);
		expect(outside.refund).not.toHaveBeenCalled();
	});

	test("marks the order shipped on Shopify and here", async () => {
		const outside = fakes();
		const id = await ship();
		const result = await sendTracking(db, id, outside);

		expect(result.sent).toBe(true);
		expect(outside.shopifyFulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			{
				company: "USPS",
				boxes: [
					{ number: "9400100000000000000000", url: "https://tools.usps.com/x" },
				],
			},
		);
		expect((await handoffOf(id)).channelFulfillmentId).toBe(
			"gid://shopify/Fulfillment/1",
		);
		expect((await orderRow()).fulfillmentStatus).toBe("FULFILLED");
		expect((await orderRow()).pin).toBeNull();
	});

	test("every box's tracking goes to Shopify in one fulfillment", async () => {
		const outside = fakes();
		const id = await ship([{}, { trackingNumber: "9400B" }]);
		await sendTracking(db, id, outside);
		expect(outside.shopifyFulfill).toHaveBeenCalledTimes(1);
		expect(outside.shopifyFulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			expect.objectContaining({
				boxes: [
					expect.objectContaining({ number: "9400100000000000000000" }),
					expect.objectContaining({ number: "9400B" }),
				],
			}),
		);
	});

	test("a combined box tells each order, and one refusal doesn't stop the other", async () => {
		const other = await addOrder("10", "shopify");
		await assignOrderPins(db);
		const outside = fakes({
			shopifyFulfill: vi.fn(async (externalId: string) => {
				if (externalId.endsWith("/10")) throw new Error("Access denied");
				return "gid://shopify/Fulfillment/1";
			}),
		});
		const id = await ship(undefined, [orderId, other]);
		const result = await sendTracking(db, id, outside);

		expect(result.sent).toBe(false);
		expect(result.message).toContain("10: Tracking didn't reach Shopify");
		expect((await handoffOf(id)).channelSentAt).not.toBeNull();
		expect((await handoffOf(id, other)).channelError).toBe("Access denied");
		expect((await orderRow()).fulfillmentStatus).toBe("FULFILLED");
		expect((await orderRow(other)).fulfillmentStatus).toBe("UNFULFILLED");

		// The retry only tells the order that wasn't told.
		const retry = fakes();
		expect((await sendTracking(db, id, retry)).sent).toBe(true);
		expect(retry.shopifyFulfill).toHaveBeenCalledTimes(1);
		expect(retry.shopifyFulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/10",
			expect.anything(),
		);
	});

	test("a cancelled order's label is flagged to void, never sent", async () => {
		const outside = fakes();
		// Another order shipped first, so this order's ids and its
		// dispatch's don't line up by chance.
		await ship(undefined, [await addOrder("8", "shopify")]);
		const id = await ship();
		await db
			.update(schema.orders)
			.set({ cancelledAt: new Date() })
			.where(eq(schema.orders.id, orderId));
		const flagged = async () =>
			(
				await db
					.select({ labelToVoid })
					.from(schema.orders)
					.where(eq(schema.orders.id, orderId))
			)[0].labelToVoid;

		expect((await sendTracking(db, id, outside)).sent).toBe(false);
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
		expect(await flagged()).toBe(true);
		await voidDispatch(db, id, outside);
		expect(await flagged()).toBe(false);
	});

	test("a shipment missing a box, or with one voided, never sends tracking", async () => {
		const outside = fakes();
		const { dispatchId: incomplete } = await addDispatch(db, {
			orderIds: [orderId],
			bought: false,
		});
		await expect(sendTracking(db, incomplete, outside)).rejects.toThrow(
			"Not every box",
		);
		await voidDispatch(db, incomplete, outside);

		const partly = await ship([{}, { voidedAt: new Date() }]);
		await expect(sendTracking(db, partly, outside)).rejects.toThrow(
			"Some labels in this shipment were voided",
		);
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
		expect((await orderRow()).fulfillmentStatus).toBe("UNFULFILLED");
	});

	test("never sends a test label's fake tracking", async () => {
		const outside = fakes();
		const result = await sendTracking(
			db,
			await ship([{ test: true }]),
			outside,
		);
		expect(result.sent).toBe(false);
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
		expect((await orderRow()).fulfillmentStatus).toBe("UNFULFILLED");
	});

	test("a refusal is recorded and the order stays to ship", async () => {
		const outside = fakes({
			shopifyFulfill: vi.fn(async () => {
				throw new Error("Access denied");
			}),
		});
		const id = await ship();
		const result = await sendTracking(db, id, outside);
		expect(result).toEqual({
			sent: false,
			message: "Tracking didn't reach Shopify: Access denied",
		});
		expect((await handoffOf(id)).channelError).toBe("Access denied");
		expect((await orderRow()).fulfillmentStatus).toBe("UNFULFILLED");
		expect((await orderRow()).pin).not.toBeNull();
	});
});

describe("sendTracking on eBay", () => {
	beforeEach(() => setUp("ebay"));

	test("sends every line with its quantity", async () => {
		const outside = fakes();
		await sendTracking(db, await ship(), outside);
		expect(outside.ebayFulfill).toHaveBeenCalledWith(
			"9",
			expect.objectContaining({
				lineItems: [{ lineItemId: "line-9", quantity: 2 }],
				carrier: "USPS",
				trackingNumber: "9400100000000000000000",
			}),
		);
	});

	test("several boxes still send each line once, with the first box's number", async () => {
		const outside = fakes();
		const result = await sendTracking(
			db,
			await ship([{}, { trackingNumber: "9400B" }]),
			outside,
		);
		expect(outside.ebayFulfill).toHaveBeenCalledTimes(1);
		expect(outside.ebayFulfill).toHaveBeenCalledWith(
			"9",
			expect.objectContaining({ trackingNumber: "9400100000000000000000" }),
		);
		expect(result.message).toContain("one number");
	});
});

describe("voidDispatch", () => {
	beforeEach(() => setUp("shopify"));

	test("refunds once, cancels on Shopify, and puts the order back", async () => {
		const outside = fakes();
		const id = await ship();
		await sendTracking(db, id, outside);

		const result = await voidDispatch(db, id, outside);
		expect(result.refundStatus).toBe("QUEUED");
		expect(outside.shopifyCancel).toHaveBeenCalledWith(
			"gid://shopify/Fulfillment/1",
		);
		expect((await orderRow()).fulfillmentStatus).toBe("UNFULFILLED");
		expect((await orderRow()).pin).not.toBeNull();

		await expect(voidDispatch(db, id, outside)).rejects.toThrow(
			"already voided",
		);
		expect(outside.refund).toHaveBeenCalledTimes(1);
	});

	test("two voids at once refund only once", async () => {
		const outside = fakes();
		const id = await ship();
		const results = await Promise.allSettled([
			voidDispatch(db, id, outside),
			voidDispatch(db, id, outside),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(outside.refund).toHaveBeenCalledTimes(1);
	});

	test("a voided label's tracking is never sent", async () => {
		const outside = fakes();
		const id = await ship();
		await voidDispatch(db, id, outside);
		await expect(sendTracking(db, id, outside)).rejects.toThrow("voided");
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
	});

	test("a refused refund leaves the label live", async () => {
		const outside = fakes({
			refund: vi.fn(async () => {
				throw new Error("already scanned");
			}),
		});
		const id = await ship();
		await expect(voidDispatch(db, id, outside)).rejects.toThrow(
			"already scanned",
		);
		expect((await boxesOf(id))[0].voidedAt).toBeNull();
	});

	test("a box refused partway keeps the rest voided and is retried alone", async () => {
		let calls = 0;
		const outside = fakes({
			refund: vi.fn(async () => {
				calls++;
				if (calls === 2) throw new Error("already scanned");
				return { status: "QUEUED" };
			}),
		});
		const id = await ship([{}, {}]);
		await sendTracking(db, id, fakes());

		const first = await voidDispatch(db, id, outside);
		expect(first.notes[0]).toContain("1 of 2 labels weren't refunded");
		expect(first.remaining).toBe(1);
		const [a, b] = await boxesOf(id);
		expect(a.voidedAt).not.toBeNull();
		expect(b.voidedAt).toBeNull();
		// Still shipped: one box is live.
		expect((await orderRow()).fulfillmentStatus).toBe("FULFILLED");

		await voidDispatch(db, id, outside);
		expect(outside.refund).toHaveBeenCalledTimes(3);
		expect((await boxesOf(id)).every((x) => x.voidedAt)).toBe(true);
		expect((await orderRow()).fulfillmentStatus).toBe("UNFULFILLED");
	});

	test("voiding a combined box puts every order back", async () => {
		const other = await addOrder("10", "shopify");
		const outside = fakes();
		const id = await ship(undefined, [orderId, other]);
		await sendTracking(db, id, outside);
		const result = await voidDispatch(db, id, outside);
		expect(outside.shopifyCancel).toHaveBeenCalledTimes(2);
		expect(
			result.notes.filter((n) => n.includes("back on To ship")),
		).toHaveLength(2);
		expect((await orderRow(other)).fulfillmentStatus).toBe("UNFULFILLED");
	});

	test("if Shopify won't cancel, the order isn't put back", async () => {
		const outside = fakes({
			shopifyCancel: vi.fn(async () => {
				throw new Error("nope");
			}),
		});
		const id = await ship();
		await sendTracking(db, id, outside);
		const result = await voidDispatch(db, id, outside);
		expect(result.notes[0]).toContain("Shopify still shows it shipped");
		expect((await orderRow()).fulfillmentStatus).toBe("FULFILLED");
	});
});
