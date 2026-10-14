import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import {
	type Outside,
	retryStorefrontTracking,
	sendTracking,
	voidShipment,
} from "./handoff";
import { assignOrderPins } from "./pins";

let db: Db;
let orderId: number;

function fakes(overrides: Partial<Outside> = {}): Outside {
	return {
		shopifyFulfill: vi.fn(async () => "gid://shopify/Fulfillment/1"),
		shopifyCancel: vi.fn(async () => {}),
		shopifySaveTracking: vi.fn(async () => {}),
		shopifyRemoveTracking: vi.fn(async () => {}),
		ebayFulfill: vi.fn(async () => "ebay-f-1"),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		tiktokShip: vi.fn(async (id: string) => ({ id, trackingNumber: "TT1" })),
		...overrides,
	};
}

async function setUp(channel: "shopify" | "ebay") {
	db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel, name: channel })
		.returning();
	[{ id: orderId }] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: channel === "shopify" ? "gid://shopify/Order/9" : "12-34",
			name: "#9",
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 30,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	await db.insert(schema.orderLines).values({
		orderId,
		externalId: "line-1",
		sku: "WRENCH",
		title: "Wrench",
		quantity: 2,
		unitPrice: 15,
	});
	await assignOrderPins(db);
}

async function addLabel(
	extra: Partial<typeof schema.shipments.$inferInsert> = {},
) {
	const [row] = await db
		.insert(schema.shipments)
		.values({
			orderId,
			contentsKey: "WRENCH×2",
			lengthMm: 300,
			widthMm: 200,
			heightMm: 100,
			weightGrams: 600,
			provider: "shippo",
			carrier: "USPS",
			carrierToken: "usps",
			service: "usps_ground_advantage",
			serviceName: "USPS Ground Advantage",
			cost: 7.08,
			trackingNumber: "9400100000000000000000",
			trackingUrl: "https://tools.usps.com/x",
			labelUrl: "https://example.com/label.pdf",
			externalId: `tx-${Math.random()}`,
			test: false,
			...extra,
		})
		.returning();
	return row.id;
}

const order = async () =>
	(
		await db.select().from(schema.orders).where(eq(schema.orders.id, orderId))
	)[0];
const label = async (id: number) =>
	(
		await db.select().from(schema.shipments).where(eq(schema.shipments.id, id))
	)[0];

describe("sendTracking", () => {
	beforeEach(() => setUp("shopify"));

	test("a TikTok label is marked ready on TikTok, which has the tracking", async () => {
		const outside = fakes();
		const id = await addLabel({
			provider: "tiktok",
			externalId: "1157817232461763469",
			trackingNumber: null,
		});
		const result = await sendTracking(db, id, outside);

		expect(result.sent).toBe(true);
		expect(outside.tiktokShip).toHaveBeenCalledWith("1157817232461763469");
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
		expect(await label(id)).toMatchObject({
			trackingNumber: "TT1",
			channelFulfillmentId: "1157817232461763469",
		});
		expect((await order()).fulfillmentStatus).toBe("FULFILLED");
	});

	test("a TikTok label can't be voided from here", async () => {
		const outside = fakes();
		const id = await addLabel({ provider: "tiktok", externalId: "115" });
		await expect(voidShipment(db, id, outside)).rejects.toThrow(
			"Seller Center",
		);
		expect(outside.refund).not.toHaveBeenCalled();
	});

	test("the shipping email links to the storefront's signed tracking page", async () => {
		vi.stubEnv("TRACKING_LINK_SECRET", "test-secret");
		vi.stubEnv("STOREFRONT_ORIGIN", "https://shop.example/");
		const outside = fakes();
		await sendTracking(db, await addLabel(), outside);
		expect(outside.shopifyFulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			expect.objectContaining({
				url: `https://shop.example/track/9/${createHmac("sha256", "test-secret").update("track:9").digest("base64url")}`,
			}),
		);
		vi.unstubAllEnvs();
	});

	test("marks the order shipped on Shopify and here", async () => {
		// Without the storefront set up, the email keeps the carrier's link.
		vi.stubEnv("TRACKING_LINK_SECRET", "");
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		const outside = fakes();
		const id = await addLabel();
		const result = await sendTracking(db, id, outside);

		expect(result.sent).toBe(true);
		expect(outside.shopifyFulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			{
				company: "USPS",
				number: "9400100000000000000000",
				url: "https://tools.usps.com/x",
			},
		);
		expect((await label(id)).channelFulfillmentId).toBe(
			"gid://shopify/Fulfillment/1",
		);
		expect((await order()).fulfillmentStatus).toBe("FULFILLED");
		expect((await order()).pin).toBeNull();
		expect(warned).toHaveBeenCalledWith(
			expect.stringContaining("TRACKING_LINK_SECRET isn't set"),
		);
		warned.mockRestore();
		vi.unstubAllEnvs();
	});

	test("lists the label's Shippo carrier token on the order for the storefront", async () => {
		const outside = fakes();
		await sendTracking(db, await addLabel(), outside);
		expect(outside.shopifySaveTracking).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			{
				number: "9400100000000000000000",
				carrier: "usps",
				url: "https://tools.usps.com/x",
			},
		);
	});

	test("a label bought before the token was kept still ships, unlisted", async () => {
		const outside = fakes();
		const result = await sendTracking(
			db,
			await addLabel({ carrierToken: null }),
			outside,
		);
		expect(result.sent).toBe(true);
		expect(outside.shopifySaveTracking).not.toHaveBeenCalled();
	});

	test("if the storefront entry isn't saved, the order still ships and the label says so", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const outside = fakes({
			shopifySaveTracking: vi.fn(async () => {
				throw new Error("Access denied");
			}),
		});
		const id = await addLabel();
		const result = await sendTracking(db, id, outside);

		expect(result.sent).toBe(true);
		expect(result.message).toContain("katasync.shippo_tracking");
		expect(await label(id)).toMatchObject({
			channelError: null,
			storefrontTrackingError: expect.stringContaining("Access denied"),
		});
		expect((await label(id)).channelSentAt).not.toBeNull();
		expect((await order()).fulfillmentStatus).toBe("FULFILLED");
		expect(logged).toHaveBeenCalledWith(
			expect.stringContaining("STOREFRONT TRACKING NOT UPDATED"),
			expect.any(Error),
		);
		logged.mockRestore();
	});

	test("never sends a test label's fake tracking", async () => {
		const outside = fakes();
		const result = await sendTracking(
			db,
			await addLabel({ test: true }),
			outside,
		);
		expect(result.sent).toBe(false);
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
		expect((await order()).fulfillmentStatus).toBe("UNFULFILLED");
	});

	test("a refusal is recorded and the order stays to ship", async () => {
		const outside = fakes({
			shopifyFulfill: vi.fn(async () => {
				throw new Error("Access denied");
			}),
		});
		const id = await addLabel();
		const result = await sendTracking(db, id, outside);
		expect(result).toEqual({
			sent: false,
			message: "Tracking didn't reach Shopify: Access denied",
		});
		expect((await label(id)).channelError).toBe("Access denied");
		expect((await order()).fulfillmentStatus).toBe("UNFULFILLED");
		expect((await order()).pin).not.toBeNull();
	});
});

describe("sendTracking on eBay", () => {
	beforeEach(() => setUp("ebay"));

	test("sends every line with its quantity", async () => {
		const outside = fakes();
		await sendTracking(db, await addLabel(), outside);
		expect(outside.ebayFulfill).toHaveBeenCalledWith(
			"12-34",
			expect.objectContaining({
				lineItems: [{ lineItemId: "line-1", quantity: 2 }],
				carrier: "USPS",
				trackingNumber: "9400100000000000000000",
			}),
		);
	});
});

describe("voidShipment", () => {
	beforeEach(() => setUp("shopify"));

	test("refunds once, cancels on Shopify, and puts the order back", async () => {
		const outside = fakes();
		const id = await addLabel();
		await sendTracking(db, id, outside);

		const result = await voidShipment(db, id, outside);
		expect(result.refundStatus).toBe("QUEUED");
		expect(outside.shopifyCancel).toHaveBeenCalledWith(
			"gid://shopify/Fulfillment/1",
		);
		expect(outside.shopifyRemoveTracking).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			"9400100000000000000000",
		);
		expect((await order()).fulfillmentStatus).toBe("UNFULFILLED");
		expect((await order()).pin).not.toBeNull();

		await expect(voidShipment(db, id, outside)).rejects.toThrow(
			"already voided",
		);
		expect(outside.refund).toHaveBeenCalledTimes(1);
	});

	test("two voids at once refund only once", async () => {
		const outside = fakes();
		const id = await addLabel();
		const results = await Promise.allSettled([
			voidShipment(db, id, outside),
			voidShipment(db, id, outside),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(outside.refund).toHaveBeenCalledTimes(1);
	});

	test("a voided label's tracking is never sent", async () => {
		const outside = fakes();
		const id = await addLabel();
		await voidShipment(db, id, outside);
		await expect(sendTracking(db, id, outside)).rejects.toThrow("voided");
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
	});

	test("a refused refund leaves the label live", async () => {
		const outside = fakes({
			refund: vi.fn(async () => {
				throw new Error("already scanned");
			}),
		});
		const id = await addLabel();
		await expect(voidShipment(db, id, outside)).rejects.toThrow(
			"already scanned",
		);
		expect((await label(id)).voidedAt).toBeNull();
	});

	test("if Shopify won't cancel, the order isn't put back", async () => {
		const outside = fakes({
			shopifyCancel: vi.fn(async () => {
				throw new Error("nope");
			}),
		});
		const id = await addLabel();
		await sendTracking(db, id, outside);
		const result = await voidShipment(db, id, outside);
		expect(result.notes[0]).toContain("Shopify still shows it shipped");
		expect((await order()).fulfillmentStatus).toBe("FULFILLED");
	});

	test("if the storefront entry can't be removed, the void still goes through and says so", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const outside = fakes({
			shopifyRemoveTracking: vi.fn(async () => {
				throw new Error("nope");
			}),
		});
		const id = await addLabel();
		await sendTracking(db, id, outside);
		const result = await voidShipment(db, id, outside);
		expect(result.notes).toContainEqual(
			expect.stringContaining("katasync.shippo_tracking"),
		);
		expect((await label(id)).voidedAt).not.toBeNull();
		expect((await label(id)).storefrontTrackingError).toContain(
			"Remove tracking 9400100000000000000000",
		);
		expect((await order()).fulfillmentStatus).toBe("UNFULFILLED");
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});

describe("retryStorefrontTracking", () => {
	beforeEach(() => setUp("shopify"));

	test("saves a shipped label's entry and clears the note", async () => {
		const outside = fakes();
		const id = await addLabel({ storefrontTrackingError: "not saved" });
		const result = await retryStorefrontTracking(db, id, outside);
		expect(result.sent).toBe(true);
		expect(outside.shopifySaveTracking).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			{
				number: "9400100000000000000000",
				carrier: "usps",
				url: "https://tools.usps.com/x",
			},
		);
		expect((await label(id)).storefrontTrackingError).toBeNull();
	});

	test("removes a voided label's entry instead", async () => {
		const outside = fakes();
		const id = await addLabel({
			storefrontTrackingError: "not removed",
			voidedAt: new Date(),
		});
		await retryStorefrontTracking(db, id, outside);
		expect(outside.shopifyRemoveTracking).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			"9400100000000000000000",
		);
		expect(outside.shopifySaveTracking).not.toHaveBeenCalled();
		expect((await label(id)).storefrontTrackingError).toBeNull();
	});

	test("another refusal, a timeout included, replaces the note with the new reason", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const outside = fakes({
			shopifySaveTracking: vi.fn(async () => {
				throw new Error("Shopify didn't answer within 5000ms");
			}),
		});
		const id = await addLabel({ storefrontTrackingError: "not saved" });
		const result = await retryStorefrontTracking(db, id, outside);
		expect(result.sent).toBe(false);
		expect(result.message).toContain("didn't answer within 5000ms");
		expect((await label(id)).storefrontTrackingError).toBe(result.message);
		logged.mockRestore();
	});
});
