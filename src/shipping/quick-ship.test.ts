import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { externalFulfillment, labelSource } from "#/orders/fulfillment";
import { createProduct, createTestDb } from "#/test/db";
import { contentsKey } from "./contents";
import { assignOrderPins } from "./pins";
import {
	lastPackedFor,
	needsInsurance,
	orderForShipping,
	rankRates,
} from "./quick-ship";
import type { Rate } from "./shippo";

describe("contentsKey", () => {
	test("merges repeated SKUs and ignores order and case", () => {
		expect(
			contentsKey([
				{ sku: "wrench", title: "Wrench", quantity: 1 },
				{ sku: "BOX-A", title: "Box", quantity: 2 },
				{ sku: "WRENCH", title: "Wrench", quantity: 2 },
			]),
		).toBe("BOX-A×2|WRENCH×3");
	});

	test("custom items without a SKU use their title", () => {
		expect(contentsKey([{ sku: null, title: "Repair", quantity: 1 }])).toBe(
			"REPAIR×1",
		);
	});
});

describe("needsInsurance and labelSource", () => {
	test("insures expensive orders and items that ask for it", () => {
		const cheap = [{ insureWhenShipped: false }];
		expect(needsInsurance({ total: 499, lines: cheap })).toBe(false);
		expect(needsInsurance({ total: 501, lines: cheap })).toBe(true);
		expect(
			needsInsurance({ total: 20, lines: [{ insureWhenShipped: true }] }),
		).toBe(true);
	});

	test("Amazon and TikTok keep their own labels", () => {
		expect(labelSource({ channel: "amazon", salesChannel: "Amazon" })).toBe(
			"amazon",
		);
		expect(labelSource({ channel: "shopify", salesChannel: "TikTok" })).toBe(
			"tiktok",
		);
		expect(labelSource({ channel: "tiktok", salesChannel: null })).toBe(
			"tiktok",
		);
		expect(labelSource({ channel: "ebay", salesChannel: null })).toBe("shippo");
	});
});

describe("externalFulfillment", () => {
	test("links Amazon and TikTok orders to their marketplace page", () => {
		expect(
			externalFulfillment({
				channel: "amazon",
				salesChannel: "Amazon",
				marketplaceOrderId: "amazon:111-2557110-8817016",
			})?.url,
		).toBe(
			"https://sellercentral.amazon.com/orders-v3/order/111-2557110-8817016",
		);
		expect(
			externalFulfillment({
				channel: "shopify",
				salesChannel: "TikTok",
				marketplaceOrderId: "tiktok:5770000000000001",
			})?.url,
		).toBe(
			"https://seller-us.tiktok.com/order/detail?order_no=5770000000000001",
		);
		expect(
			externalFulfillment({
				channel: "shopify",
				salesChannel: "Online Store",
				marketplaceOrderId: null,
			}),
		).toBeNull();
	});
});

describe("rankRates", () => {
	const rate = (service: string, cost: number): Rate => ({
		id: service,
		carrier: "USPS",
		service,
		serviceName: service,
		cost,
		days: 2,
	});

	test("same contents beat same box, which beats cheapest", () => {
		const ranked = rankRates(
			[rate("cheap", 5), rate("box", 9), rate("contents", 12)],
			[
				{ service: "box", sameContents: 0, samePackage: 4 },
				{ service: "contents", sameContents: 1, samePackage: 0 },
			],
		);
		expect(ranked.map((r) => r.service)).toEqual(["contents", "box", "cheap"]);
	});
});

describe("with a database", () => {
	let db: Db;
	let storeId: number;

	const addOrder = async (name: string, extra = {}) => {
		const [row] = await db
			.insert(schema.orders)
			.values({
				storeId,
				externalId: name,
				name,
				placedAt: new Date(),
				fulfillmentStatus: "UNFULFILLED",
				total: 40,
				sourceUpdatedAt: new Date(),
				...extra,
			})
			.returning();
		return row.id;
	};

	beforeEach(async () => {
		db = await createTestDb();
		[{ id: storeId }] = await db
			.insert(schema.stores)
			.values({ channel: "shopify", name: "Shopify" })
			.returning();
	});

	test("pins go to orders to ship and come back once shipped", async () => {
		const open = await addOrder("#1");
		const cancelled = await addOrder("#2", { cancelledAt: new Date() });
		expect(await assignOrderPins(db)).toBe(1);

		const pinOf = async (id: number) =>
			(await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0]
				.pin;
		const pin = await pinOf(open);
		// The first pins are a single key.
		expect(pin).toBeGreaterThanOrEqual(1);
		expect(pin).toBeLessThanOrEqual(9);
		expect(await pinOf(cancelled)).toBeNull();

		// Running again keeps the same pin.
		expect(await assignOrderPins(db)).toBe(0);
		expect(await pinOf(open)).toBe(pin);

		await db
			.update(schema.orders)
			.set({ fulfillmentStatus: "FULFILLED" })
			.where(eq(schema.orders.id, open));
		await assignOrderPins(db);
		expect(await pinOf(open)).toBeNull();
	});

	test("invoices get the box and weight these contents last shipped in", async () => {
		const order = await addOrder("#1");
		const [box] = await db
			.insert(schema.packages)
			.values({
				pin: 4,
				name: "Flat",
				lengthMm: 300,
				widthMm: 200,
				heightMm: 50,
			})
			.returning();
		const ship = (externalId: string, weightGrams: number, at: string) =>
			db.insert(schema.shipments).values({
				orderId: order,
				packageId: box.id,
				contentsKey: "WRENCH×2",
				lengthMm: 300,
				widthMm: 200,
				heightMm: 50,
				weightGrams,
				provider: "shippo",
				carrier: "USPS",
				service: "usps_ground_advantage",
				serviceName: "USPS Ground Advantage",
				cost: 8,
				labelUrl: "https://example.com/label.pdf",
				externalId,
				test: true,
				createdAt: new Date(at),
			});
		await ship("old", 500, "2026-10-01T00:00:00Z");
		await ship("new", 567, "2026-10-05T00:00:00Z");

		const last = await lastPackedFor(db, ["WRENCH×2", "NEVER×1"]);
		expect(last.get("WRENCH×2")).toEqual({
			contentsKey: "WRENCH×2",
			boxPin: 4,
			weightGrams: 567,
		});
		expect(last.has("NEVER×1")).toBe(false);
	});

	test("pins stay one digit until those run out", async () => {
		for (let i = 1; i <= 10; i++) await addOrder(`#${i}`);
		await assignOrderPins(db);
		const pins = (
			await db.select({ pin: schema.orders.pin }).from(schema.orders)
		).map((o) => o.pin as number);
		expect(pins.filter((p) => p <= 9).sort()).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9,
		]);
		expect(pins.filter((p) => p >= 10 && p <= 99)).toHaveLength(1);
	});

	test("a pin finds the order with the box and weight used last time", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await db
			.update(schema.products)
			.set({ weightGrams: 300 })
			.where(eq(schema.products.id, wrench));
		const first = await addOrder("#1");
		const second = await addOrder("#2");
		for (const orderId of [first, second]) {
			await db.insert(schema.orderLines).values({
				orderId,
				externalId: `${orderId}`,
				productId: wrench,
				sku: "WRENCH",
				title: "Wrench",
				quantity: 2,
				unitPrice: 20,
			});
		}
		await assignOrderPins(db);
		const [{ pin }] = await db
			.select({ pin: schema.orders.pin })
			.from(schema.orders)
			.where(eq(schema.orders.id, second));

		const before = await orderForShipping(db, pin as number);
		expect(before?.contentsKey).toBe("WRENCH×2");
		expect(before?.itemsWeightGrams).toBe(600);
		expect(before?.last).toBeNull();

		await db.insert(schema.shipments).values({
			orderId: first,
			contentsKey: "WRENCH×2",
			lengthMm: 300,
			widthMm: 200,
			heightMm: 100,
			weightGrams: 700,
			provider: "shippo",
			carrier: "USPS",
			service: "usps_ground_advantage",
			serviceName: "USPS Ground Advantage",
			cost: 8,
			labelUrl: "https://example.com/label.pdf",
			externalId: "t1",
			test: true,
		});
		const after = await orderForShipping(db, pin as number);
		expect(after?.last?.weightGrams).toBe(700);
		expect(after?.labelsBought).toBe(0);
	});
});
