import { describe, expect, test } from "vitest";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	DEMAND_DAYS,
	forecastOf,
	forecasts,
	MIN_DEMAND_DAYS,
	measuredLeadTime,
	safetyStock,
} from "./forecast";

const days = (units: number[], inStock = true) =>
	units.map((u) => ({ units: u, inStock }));

describe("forecastOf", () => {
	test("spreads sales over the days in stock, not the whole window", () => {
		// 30 in stock days selling 1 each, then 60 out of stock.
		const f = forecastOf([
			...days(Array(30).fill(1)),
			...days(Array(60).fill(0), false),
		]);
		expect(f).toMatchObject({ dailyDemand: 1, dailySd: 0, inStockDays: 30 });
	});

	test("a day that sold counts even if the shelf read empty", () => {
		const f = forecastOf([...days([2], false), ...days(Array(29).fill(0))]);
		expect(f.inStockDays).toBe(30);
	});

	test("never spreads over fewer than the minimum days", () => {
		const f = forecastOf([...days([4]), ...days(Array(89).fill(0), false)]);
		expect(f.dailyDemand).toBe(4 / MIN_DEMAND_DAYS);
	});

	test("nothing in stock and nothing sold is no demand", () => {
		expect(forecastOf(days(Array(90).fill(0), false)).dailyDemand).toBe(0);
	});
});

describe("safetyStock", () => {
	const steady = { dailyDemand: 2, dailySd: 1, inStockDays: 90 };

	test("is bigger for higher classes", () => {
		const a = safetyStock(steady, "A", 16);
		const b = safetyStock(steady, "B", 16);
		const c = safetyStock(steady, "C", 16);
		// z × 1 × √16: 8.2, 6.6, 5.1, rounded up.
		expect([a, b, c]).toEqual([9, 7, 6]);
		expect(safetyStock(steady, null, 16)).toBe(c);
	});

	test("never more than the lead time's demand", () => {
		const lumpy = { dailyDemand: 0.5, dailySd: 6, inStockDays: 90 };
		expect(safetyStock(lumpy, "A", 10)).toBe(5);
	});
});

describe("measuredLeadTime", () => {
	test("needs three POs, then takes the median, rounded up", () => {
		expect(measuredLeadTime([5, 6])).toBeNull();
		expect(measuredLeadTime([5, 6, 30])).toEqual({ days: 6, pos: 3 });
		expect(measuredLeadTime([5, 6, 7, 8])).toEqual({ days: 7, pos: 4 });
	});

	test("is at least a day", () => {
		expect(measuredLeadTime([0.01, 0.02, 0.03])?.days).toBe(1);
	});
});

test("rebuilds stock from the ledger to find days out of stock", async () => {
	const db = await createTestDb();
	const now = new Date();
	const midday = (daysAgo: number) =>
		new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
				daysAgo * 86_400_000 +
				12 * 3_600_000,
		);
	const [{ id: shelf }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	const [{ id: store }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shop" })
		.returning();
	const blade = await createProduct(db, "BLADE", "simple");

	// The ledger starts 60 days ago with 10 on the shelf; all 10 sell 40 days
	// ago and it's been empty since.
	await db.insert(schema.movements).values([
		{
			batchId: crypto.randomUUID(),
			productId: blade,
			locationId: shelf,
			delta: 10,
			reason: "opening_balance",
			createdAt: midday(60),
		},
		{
			batchId: crypto.randomUUID(),
			productId: blade,
			locationId: shelf,
			delta: -10,
			reason: "sale",
			createdAt: midday(40),
		},
	]);
	await db
		.insert(schema.stockLevels)
		.values({ productId: blade, locationId: shelf, onHand: 0 });
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store,
			externalId: "o1",
			name: "#1",
			placedAt: midday(40),
			fulfillmentStatus: "FULFILLED",
			total: 1,
			sourceUpdatedAt: now,
		})
		.returning();
	await db.insert(schema.orderLines).values({
		orderId: order.id,
		externalId: "l1",
		productId: blade,
		title: "x",
		quantity: 10,
		unitPrice: 1,
	});

	const f = (await forecasts(db, now)).get(blade);
	// In stock: the window's days before the ledger began (assumed: 61 to 89
	// days ago), the 20 days with 10 on the shelf (60 to 41 days ago), and the
	// day it sold out.
	const inStockDays = DEMAND_DAYS - 61 + 20 + 1;
	expect(f).toMatchObject({ inStockDays, dailyDemand: 10 / inStockDays });
});
