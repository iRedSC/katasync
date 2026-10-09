import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { contentsKey } from "./contents";
import { assignOrderPins } from "./pins";
import {
	labelSource,
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
		expect(labelSource({ channel: "ebay", salesChannel: null })).toBe("shippo");
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
		expect(pin).toBeGreaterThanOrEqual(100);
		expect(pin).toBeLessThanOrEqual(999);
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
