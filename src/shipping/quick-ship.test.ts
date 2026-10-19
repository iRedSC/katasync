import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { externalFulfillment, labelSource } from "#/orders/fulfillment";
import { addDispatch, createProduct, createTestDb } from "#/test/db";
import { contentsKey } from "./contents";
import { addressKey, companionsOf, whyNotTogether } from "./dispatch";
import { assignOrderPins } from "./pins";
import {
	combineRates,
	lastPackedFor,
	needsInsurance,
	orderForShipping,
	rankRates,
	shipmentPlan,
	signatureRequired,
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

	test("eBay orders of $750 or more need a signature", () => {
		expect(signatureRequired([{ channel: "ebay", total: 749.99 }])).toBeNull();
		expect(signatureRequired([{ channel: "shopify", total: 900 }])).toBeNull();
		expect(
			signatureRequired([
				{ channel: "shopify", total: 20 },
				{ channel: "ebay", total: 750 },
			]),
		).toContain("eBay");
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
	test("links Amazon orders to their marketplace page", () => {
		expect(
			externalFulfillment({
				channel: "amazon",
				salesChannel: "Amazon",
				marketplaceOrderId: "amazon:111-2557110-8817016",
			})?.url,
		).toBe(
			"https://sellercentral.amazon.com/orders-v3/order/111-2557110-8817016",
		);
		// TikTok labels are bought in katasync now.
		expect(
			externalFulfillment({
				channel: "shopify",
				salesChannel: "TikTok",
				marketplaceOrderId: "tiktok:5770000000000001",
			}),
		).toBeNull();
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
				name: "Flat",
				lengthMm: 300,
				widthMm: 200,
				heightMm: 50,
			})
			.returning();
		const ship = (weights: number[], at: string) =>
			addDispatch(db, {
				orderIds: [order],
				contentsKey: "WRENCH×2",
				createdAt: new Date(at),
				boxes: weights.map((weightGrams) => ({
					packageId: box.id,
					weightGrams,
					test: true,
				})),
			});
		await ship([500], "2026-10-01T00:00:00Z");
		await ship([567, 900], "2026-10-05T00:00:00Z");

		const last = await lastPackedFor(db, ["WRENCH×2", "NEVER×1"]);
		// The first box of the latest shipment, and how many boxes it took.
		expect(last.get("WRENCH×2")).toEqual({
			contentsKey: "WRENCH×2",
			// The size the label was bought at, which is the shipment's own.
			boxName: "Flat",
			lengthMm: 300,
			widthMm: 200,
			heightMm: 100,
			weightGrams: 567,
			boxes: 2,
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

	const addLine = (orderId: number, productId: number | null, quantity = 2) =>
		db.insert(schema.orderLines).values({
			orderId,
			externalId: `${orderId}-${productId}`,
			productId,
			sku: "WRENCH",
			title: "Wrench",
			quantity,
			unitPrice: 20,
		});

	const pinOf = async (id: number) =>
		(
			await db
				.select({ pin: schema.orders.pin })
				.from(schema.orders)
				.where(eq(schema.orders.id, id))
		)[0].pin as number;

	test("a pin finds the order with every box used last time", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await db
			.update(schema.products)
			.set({ weightGrams: 300 })
			.where(eq(schema.products.id, wrench));
		const first = await addOrder("#1");
		const second = await addOrder("#2");
		for (const orderId of [first, second]) await addLine(orderId, wrench);
		await assignOrderPins(db);

		const before = await orderForShipping(db, await pinOf(second));
		expect(before?.plan.contentsKey).toBe("WRENCH×2");
		expect(before?.plan.itemsWeightGrams).toBe(600);
		expect(before?.plan.last).toBeNull();

		await addDispatch(db, {
			orderIds: [first],
			boxes: [{ weightGrams: 700 }, { weightGrams: 400 }],
		});
		const after = await orderForShipping(db, await pinOf(second));
		expect(after?.plan.last?.map((b) => b.weightGrams)).toEqual([700, 400]);
		expect(after?.liveDispatchId).toBeNull();
	});

	const address = {
		shipAddress1: "12 Oak St.",
		shipCity: "Erie",
		shipPostalCode: "16501",
		shipCountry: "US",
	};

	const candidate = async (id: number) => {
		const [o] = await db
			.select()
			.from(schema.orders)
			.where(eq(schema.orders.id, id));
		return { ...o, channel: "shopify", needsShipping: true };
	};

	test("postal codes match however they're written", async () => {
		const canada = { ...address, shipCountry: "CA" };
		const a = await addOrder("#1", { ...canada, shipPostalCode: "K1A 0B1" });
		await addOrder("#2", { ...canada, shipPostalCode: "k1a0b1" });
		expect(
			(await companionsOf(db, await candidate(a))).map((c) => c.name),
		).toEqual(["#2"]);
	});

	test("offers other orders to the same address to share the box", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const a = await addOrder("#1", address);
		// Same place, written differently, with ZIP+4.
		const b = await addOrder("#2", {
			...address,
			shipAddress1: "12 oak st",
			shipPostalCode: "16501-1234",
		});
		const otherStreet = await addOrder("#3", {
			...address,
			shipAddress1: "14 Oak St",
		});
		const shipped = await addOrder("#4", {
			...address,
			fulfillmentStatus: "FULFILLED",
		});
		const labelled = await addOrder("#5", address);
		for (const id of [a, b, otherStreet, shipped, labelled])
			await addLine(id, wrench, 1);
		await addDispatch(db, { orderIds: [labelled] });
		await assignOrderPins(db);

		const found = await orderForShipping(db, await pinOf(a));
		expect(found?.companions.map((c) => c.name)).toEqual(["#2"]);
		// An order already holding a label is offered nothing, and isn't
		// offered to others.
		expect(await companionsOf(db, { ...(await candidate(labelled)) })).toEqual(
			[],
		);
		expect(found?.companions[0]).toMatchObject({ items: 1 });

		const together = await shipmentPlan(db, [a, b]);
		expect(together.contentsKey).toBe("WRENCH×2");
		expect(together.orderNames).toEqual(["#1", "#2"]);
		expect(together.total).toBe(80);
	});
});

describe("addressKey and whyNotTogether", () => {
	const order = (id: number, extra: Record<string, unknown> = {}) => ({
		id,
		name: `#${id}`,
		channel: "shopify",
		salesChannel: "Online Store",
		marketplaceOrderId: null,
		needsShipping: true,
		shipAddress1: "12 Oak St.",
		shipAddress2: null,
		shipPostalCode: "16501",
		shipCountry: "US",
		...extra,
	});

	test("matches the same place written differently", () => {
		expect(addressKey(order(1))).toBe(
			addressKey(
				order(2, { shipAddress1: "12  OAK st", shipPostalCode: "16501-0001" }),
			),
		);
		expect(addressKey(order(1, { shipAddress2: "Apt 2" }))).not.toBe(
			addressKey(order(1)),
		);
		expect(addressKey(order(1, { shipAddress1: null }))).toBeNull();
	});

	test("says why orders can't share a box", () => {
		expect(whyNotTogether([order(1), order(2)], [])).toBeNull();
		expect(
			whyNotTogether([order(1), order(2, { shipPostalCode: "16502" })], []),
		).toContain("same address");
		expect(
			whyNotTogether([order(1), order(2, { needsShipping: false })], []),
		).toContain("no longer needs shipping");
		expect(whyNotTogether([order(1), order(2)], [{ orderId: 2 }])).toContain(
			"already has a label",
		);
		expect(
			whyNotTogether([order(1), order(2, { salesChannel: "TikTok" })], []),
		).toContain("TikTok");
		// Not even two TikTok orders: TikTok combines them itself.
		expect(
			whyNotTogether(
				[
					order(1, { salesChannel: "TikTok" }),
					order(2, { salesChannel: "TikTok" }),
				],
				[],
			),
		).toContain("Seller Center");
		expect(whyNotTogether([order(1, { channel: "amazon" })], [])).toContain(
			"Amazon",
		);
	});
});

describe("combineRates", () => {
	const rate = (id: string, service: string, cost: number, days = 3): Rate => ({
		id,
		carrier: "USPS",
		service,
		serviceName: `USPS ${service}`,
		cost,
		days,
	});

	test("one box is just its rates", () => {
		expect(combineRates([[rate("a", "ground", 7)]])).toEqual([
			rate("a", "ground", 7),
		]);
	});

	test("adds up each service across boxes, keeping only shared ones", () => {
		const quotes = combineRates([
			[rate("a1", "ground", 7.1, 3), rate("a2", "priority", 10)],
			[rate("b1", "ground", 8.2, 5)],
		]);
		expect(quotes).toEqual([
			{
				id: "a1+b1",
				carrier: "USPS",
				service: "ground",
				serviceName: "USPS ground",
				cost: 15.3,
				days: 5,
			},
		]);
	});
});
