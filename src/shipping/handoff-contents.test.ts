import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { addDispatch, createTestDb } from "#/test/db";
import { memoryLocker } from "./dispatch";
import { addPackedDispatch, holdOf } from "./dispatch.fixtures";
import { type Outside, sendTracking } from "./handoff";
import { ContentsChanged, unmappable } from "./packed";
import { resendTrackingNow, retryDueTracking } from "./retry";

let db: Db;
let orderId: number;

function fakes(overrides: Partial<Outside> = {}): Outside {
	return {
		lock: memoryLocker(),
		shopifyFulfill: vi.fn(async () => ({
			fulfillmentId: "gid://shopify/Fulfillment/1",
			remaining: 0,
		})),
		shopifyCancel: vi.fn(async () => {}),
		shopifySaveTracking: vi.fn(async () => {}),
		shopifyRemoveTracking: vi.fn(async () => {}),
		ebayShip: vi.fn(async () => ({ fulfillmentId: "ebay-f-1", remaining: 0 })),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		tiktokShip: vi.fn(async (id: string) => ({ id, trackingNumber: "TT1" })),
		tiktokUnits: vi.fn(),
		...overrides,
	};
}

async function setUp(channel: "shopify" | "ebay", extra = {}) {
	db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel, name: channel })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: channel === "shopify" ? "gid://shopify/Order/9" : "9",
			name: "#9",
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 30,
			sourceUpdatedAt: new Date(),
			...extra,
		})
		.returning();
	orderId = order.id;
	await db.insert(schema.orderLines).values([
		{
			orderId,
			externalId: "L1",
			sku: "WRENCH",
			title: "Wrench",
			quantity: 2,
			unitPrice: 10,
		},
		{
			orderId,
			externalId: "L2",
			sku: "KNIFE",
			title: "Knife",
			quantity: 1,
			unitPrice: 10,
		},
	]);
}

const packed = async (
	input: Parameters<typeof addPackedDispatch>[1]["boxes"] = [{}],
) =>
	(await addPackedDispatch(db, { orderIds: [orderId], boxes: input }))
		.dispatchId;

const handoffOf = async (dispatchId: number) =>
	(
		await db
			.select()
			.from(schema.dispatchOrders)
			.where(eq(schema.dispatchOrders.dispatchId, dispatchId))
	)[0];

const statusOf = async () =>
	(
		await db.select().from(schema.orders).where(eq(schema.orders.id, orderId))
	)[0].fulfillmentStatus;

const drift = [{ line: "L1", title: "Wrench", packed: 2, open: 3 }];

afterEach(() => vi.unstubAllEnvs());

describe("Shopify", () => {
	beforeEach(async () => {
		vi.stubEnv("TRACKING_LINK_SECRET", "test-tracking-secret");
		vi.stubEnv("STOREFRONT_ORIGIN", "https://storefront.example.com");
		await setUp("shopify");
	});

	test("hands Shopify the packed quantity of every line", async () => {
		const outside = fakes();
		const id = await packed([{}, {}]);
		expect((await sendTracking(db, id, outside)).sent).toBe(true);
		expect(outside.shopifyFulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			expect.objectContaining({ boxes: expect.any(Array) }),
			new Map([
				["L1", 2],
				["L2", 1],
			]),
		);
		expect(await statusOf()).toBe("FULFILLED");
	});

	test("more still to ship on Shopify leaves the order partly fulfilled", async () => {
		const outside = fakes({
			shopifyFulfill: vi.fn(async () => ({ fulfillmentId: "f", remaining: 1 })),
		});
		expect((await sendTracking(db, await packed(), outside)).sent).toBe(true);
		expect(await statusOf()).toBe("PARTIALLY_FULFILLED");
	});

	test("a change after packing holds it, never retried, until it matches", async () => {
		const outside = fakes({
			shopifyFulfill: vi.fn(async () => {
				throw new ContentsChanged(drift);
			}),
		});
		const id = await packed();
		const result = await sendTracking(db, id, outside);
		expect(result.sent).toBe(false);
		expect(result.message).toContain("changed since it was packed");
		expect(await holdOf(db, id, orderId)).toEqual({ kind: "drift", drift });
		expect((await handoffOf(id)).channelRetryAt).toBeNull();
		expect(
			await retryDueTracking(db, new Date(Date.now() + 3_600_000), outside),
		).toMatchObject({ tried: 0 });

		expect((await resendTrackingNow(db, id, fakes())).sent).toBe(true);
		expect(await holdOf(db, id, orderId)).toBeNull();
	});

	test("held, then fixed, then a network error clears the hold and retries", async () => {
		const id = await packed();
		await sendTracking(
			db,
			id,
			fakes({
				shopifyFulfill: vi.fn(async () => {
					throw new ContentsChanged(drift);
				}),
			}),
		);
		const flaky = fakes({
			shopifyFulfill: vi.fn(async () => {
				throw new Error("fetch failed");
			}),
		});
		expect((await resendTrackingNow(db, id, flaky)).sent).toBe(false);
		const handoff = await handoffOf(id);
		expect(handoff.handoffHold).toBeNull();
		expect(handoff.channelRetryAt).not.toBeNull();
		expect(handoff.channelError).toBe("fetch failed");
	});

	test("a fulfillment Shopify already has for other items is held, not adopted", async () => {
		const outside = fakes({
			shopifyFulfill: vi.fn(async () => {
				throw unmappable(
					"Shopify already has this tracking on a fulfillment of other items",
				);
			}),
		});
		const id = await packed();
		expect((await sendTracking(db, id, outside)).sent).toBe(false);
		expect(await holdOf(db, id, orderId)).toMatchObject({ kind: "unmappable" });
		expect(await statusOf()).toBe("UNFULFILLED");
	});

	test("a dispatch bought before contents were kept is held, never sent", async () => {
		const outside = fakes();
		const { dispatchId } = await addDispatch(db, { orderIds: [orderId] });
		const result = await sendTracking(db, dispatchId, outside);
		expect(result.sent).toBe(false);
		expect(result.message).toContain(
			"bought before katasync kept what was packed",
		);
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
		expect(await holdOf(db, dispatchId, orderId)).toEqual({
			kind: "unknownContents",
		});
		expect(await db.select().from(schema.dispatchLines)).toEqual([]);
	});

	test("every box bought but the dispatch never marked (a crash) is finished by sending", async () => {
		const id = await packed();
		await db
			.update(schema.dispatches)
			.set({ boughtAt: null })
			.where(eq(schema.dispatches.id, id));
		expect((await sendTracking(db, id, fakes())).sent).toBe(true);
		const [dispatch] = await db
			.select()
			.from(schema.dispatches)
			.where(eq(schema.dispatches.id, id));
		expect(dispatch.boughtAt).not.toBeNull();
	});
});

describe("TikTok through Shopify", () => {
	beforeEach(() =>
		setUp("shopify", {
			salesChannel: "TikTok",
			marketplaceOrderId: "tiktok:577",
		}),
	);

	const units = (extra: { cancelled?: string[]; more?: boolean } = {}) =>
		vi.fn(async () => ({
			status: "AWAITING_COLLECTION",
			packages: ["pkg"],
			units: [
				...["u1", "u2"].map((id) => ({ id, sellerSku: "WRENCH" })),
				{ id: "u3", sellerSku: "KNIFE" },
				...(extra.more ? [{ id: "u4", sellerSku: "KNIFE" }] : []),
			].map((u) => ({
				...u,
				skuId: "s",
				cancelled: extra.cancelled?.includes(u.id) ?? false,
				packageId: "pkg",
			})),
		}));

	const tiktokBox = async (externalId = "pkg") =>
		(
			await addPackedDispatch(db, {
				orderIds: [orderId],
				boxes: [{ provider: "tiktok", externalId, trackingNumber: null }],
				unitIds: ["u1", "u2", "u3"],
			})
		).dispatchId;

	test("ships when TikTok's units are exactly the box", async () => {
		const outside = fakes({ tiktokUnits: units() });
		expect((await sendTracking(db, await tiktokBox(), outside)).sent).toBe(
			true,
		);
		expect(outside.tiktokShip).toHaveBeenCalledWith("pkg");
		expect(outside.tiktokUnits).toHaveBeenCalledWith("577");
	});

	test("a unit cancelled or added on TikTok holds it", async () => {
		const changes = [units({ cancelled: ["u3"] }), units({ more: true })];
		for (const [i, changed] of changes.entries()) {
			const outside = fakes({ tiktokUnits: changed });
			const id = await tiktokBox(`pkg-${i}`);
			expect((await sendTracking(db, id, outside)).sent).toBe(false);
			expect(outside.tiktokShip).not.toHaveBeenCalled();
			expect(await holdOf(db, id, orderId)).toMatchObject({ kind: "drift" });
		}
	});

	describe("two orders in one combined TikTok package", () => {
		let otherId: number;
		beforeEach(async () => {
			const [first] = await db
				.select({ storeId: schema.orders.storeId })
				.from(schema.orders)
				.where(eq(schema.orders.id, orderId));
			const [other] = await db
				.insert(schema.orders)
				.values({
					storeId: first.storeId,
					externalId: "gid://shopify/Order/10",
					name: "#10",
					salesChannel: "TikTok",
					marketplaceOrderId: "tiktok:578",
					placedAt: new Date(),
					fulfillmentStatus: "UNFULFILLED",
					total: 10,
					sourceUpdatedAt: new Date(),
				})
				.returning();
			otherId = other.id;
			await db.insert(schema.orderLines).values({
				orderId: otherId,
				externalId: "M1",
				sku: "SAW",
				title: "Saw",
				quantity: 1,
				unitPrice: 10,
			});
		});

		// Each order's own units on TikTok, all in the one package.
		const both = (otherCancelled = false) =>
			vi.fn(async (id: string) =>
				id === "577"
					? await units()()
					: {
							status: "AWAITING_COLLECTION",
							packages: ["pkg"],
							units: [
								{
									id: "v1",
									sellerSku: "SAW",
									skuId: "s",
									cancelled: otherCancelled,
									packageId: "pkg",
								},
							],
						},
			);
		const combinedBox = async () =>
			(
				await addPackedDispatch(db, {
					orderIds: [orderId, otherId],
					boxes: [
						{ provider: "tiktok", externalId: "pkg", trackingNumber: null },
					],
					unitIds: ["u1", "u2", "u3", "v1"],
				})
			).dispatchId;

		test("ships the package once both orders match it", async () => {
			const outside = fakes({ tiktokUnits: both() });
			expect((await sendTracking(db, await combinedBox(), outside)).sent).toBe(
				true,
			);
			expect(outside.tiktokShip).toHaveBeenCalledWith("pkg");
		});

		test("one order changed on TikTok ships neither", async () => {
			const outside = fakes({ tiktokUnits: both(true) });
			const id = await combinedBox();
			const result = await sendTracking(db, id, outside);
			expect(result.sent).toBe(false);
			expect(result.message).toContain("shares its TikTok package");
			expect(outside.tiktokShip).not.toHaveBeenCalled();
			expect(await holdOf(db, id, otherId)).toMatchObject({ kind: "drift" });
		});

		test("one order cancelled here ships neither", async () => {
			await db
				.update(schema.orders)
				.set({ cancelledAt: new Date() })
				.where(eq(schema.orders.id, otherId));
			const outside = fakes({ tiktokUnits: both() });
			expect((await sendTracking(db, await combinedBox(), outside)).sent).toBe(
				false,
			);
			expect(outside.tiktokShip).not.toHaveBeenCalled();
		});
	});

	test("a TikTok sale on a Shippo label is held as unmappable", async () => {
		const outside = fakes();
		const id = await packed();
		expect((await sendTracking(db, id, outside)).sent).toBe(false);
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
		expect(await holdOf(db, id, orderId)).toMatchObject({ kind: "unmappable" });
	});
});

describe("eBay", () => {
	beforeEach(() => setUp("ebay"));

	test("sends the packed quantities", async () => {
		const outside = fakes();
		const id = await packed();
		expect((await sendTracking(db, id, outside)).sent).toBe(true);
		expect(outside.ebayShip).toHaveBeenCalledWith(
			"9",
			new Map([
				["L1", 2],
				["L2", 1],
			]),
			expect.objectContaining({ carrier: "USPS" }),
		);
	});

	test("holds what eBay says changed", async () => {
		const held = fakes({
			ebayShip: vi.fn(async () => {
				throw new ContentsChanged(drift);
			}),
		});
		const again = await packed();
		expect((await sendTracking(db, again, held)).sent).toBe(false);
		expect(await holdOf(db, again, orderId)).toEqual({ kind: "drift", drift });
	});
});
