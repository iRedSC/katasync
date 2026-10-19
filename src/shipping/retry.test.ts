import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { addDispatch, createTestDb } from "#/test/db";
import { memoryLocker } from "./dispatch";
import type { Outside } from "./handoff";
import { resendTrackingNow, retryDueTracking } from "./retry";
import { nextRetry, RETRY_FOR_MS } from "./retry-window";

let db: Db;
let orderId: number;
let dispatchId: number;

function fakes(ebayFulfill: Outside["ebayFulfill"]): Outside {
	return {
		lock: memoryLocker(),
		shopifyFulfill: vi.fn(),
		shopifyCancel: vi.fn(),
		shopifySaveTracking: vi.fn(),
		shopifyRemoveTracking: vi.fn(),
		ebayFulfill,
		refund: vi.fn(),
		tiktokShip: vi.fn(),
	};
}

const refused = () =>
	fakes(
		vi.fn(async () => {
			throw new Error("eBay answered 503");
		}),
	);
const accepted = () => fakes(vi.fn(async () => "ebay-f-1"));

const handoff = async () =>
	(
		await db
			.select()
			.from(schema.dispatchOrders)
			.where(eq(schema.dispatchOrders.dispatchId, dispatchId))
	)[0];

const later = (ms: number) => new Date(Date.now() + ms);

beforeEach(async () => {
	db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "ebay", name: "eBay" })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: "12-34",
			name: "12-34",
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 30,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	orderId = order.id;
	await db.insert(schema.orderLines).values({
		orderId,
		externalId: "line-1",
		sku: "WRENCH",
		title: "Wrench",
		quantity: 1,
		unitPrice: 30,
	});
	({ dispatchId } = await addDispatch(db, { orderIds: [orderId] }));
});

describe("nextRetry", () => {
	const start = new Date("2026-10-20T12:00:00Z");
	const at = (ms: number) => new Date(start.getTime() + ms);

	test("waits double each time, from 30 seconds", () => {
		expect(nextRetry(start, 1, start)).toEqual(at(30_000));
		expect(nextRetry(start, 2, at(30_000))).toEqual(at(90_000));
		expect(nextRetry(start, 3, at(90_000))).toEqual(at(210_000));
	});

	test("tries once more at ten minutes, then stops", () => {
		expect(nextRetry(start, 5, at(450_000))).toEqual(at(RETRY_FOR_MS));
		expect(nextRetry(start, 6, at(RETRY_FOR_MS))).toBeNull();
	});
});

describe("retryDueTracking", () => {
	test("a refused send is tried again once due, and sent", async () => {
		await resendTrackingNow(db, dispatchId, refused());
		const first = await handoff();
		expect(first.channelError).toBe("eBay answered 503");
		expect(first.channelAttempts).toBe(1);
		expect(first.channelRetryAt).not.toBeNull();

		// Not due yet: nothing is tried.
		const early = accepted();
		expect(await retryDueTracking(db, new Date(), early)).toEqual({
			tried: 0,
			sent: 0,
		});
		expect(early.ebayFulfill).not.toHaveBeenCalled();

		const due = accepted();
		expect(await retryDueTracking(db, later(31_000), due)).toEqual({
			tried: 1,
			sent: 1,
		});
		const after = await handoff();
		expect(after.channelSentAt).not.toBeNull();
		expect(after.channelError).toBeNull();
		expect(after.channelRetryAt).toBeNull();
	});

	test("stops after ten minutes, leaving the error for Diagnostics", async () => {
		await db
			.update(schema.dispatchOrders)
			.set({
				channelError: "eBay answered 503",
				channelFirstFailedAt: later(-RETRY_FOR_MS - 1000),
				channelAttempts: 6,
				channelRetryAt: later(-1000),
			})
			.where(eq(schema.dispatchOrders.dispatchId, dispatchId));
		await retryDueTracking(db, new Date(), refused());
		const after = await handoff();
		expect(after.channelAttempts).toBe(7);
		expect(after.channelRetryAt).toBeNull();
		expect(after.channelError).toBe("eBay answered 503");
	});

	test("pressing Retry starts a fresh ten minutes", async () => {
		await db
			.update(schema.dispatchOrders)
			.set({
				channelError: "eBay answered 503",
				channelFirstFailedAt: later(-RETRY_FOR_MS - 1000),
				channelAttempts: 7,
			})
			.where(eq(schema.dispatchOrders.dispatchId, dispatchId));
		const result = await resendTrackingNow(db, dispatchId, refused());
		expect(result.message).toContain("Retrying on its own");
		const after = await handoff();
		expect(after.channelAttempts).toBe(1);
		expect(after.channelRetryAt).not.toBeNull();
	});
});
