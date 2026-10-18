import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { addDispatch, createProduct, createTestDb } from "#/test/db";
import { saveCostReport } from "./charges";
import {
	ordersNeedingCosts,
	profitByDay,
	profitByProduct,
	profitItems,
	profitTotals,
	resolveRange,
} from "./profit";

// The order_profit view (drizzle/0050_order_profit.sql).

let db: Db;
let shopify: number;
let amazon: number;
let wrench: number;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shopify }, { id: amazon }] = await db
		.insert(schema.stores)
		.values([
			{ channel: "shopify", name: "Shopify" },
			{ channel: "amazon", name: "Amazon US" },
		])
		.returning();
	wrench = await createProduct(db, "WRENCH", "simple");
});

async function order(
	name: string,
	lines: { unitPrice: number; quantity: number; unitCost: number | null }[],
	extra: Partial<typeof schema.orders.$inferInsert> = {},
) {
	const [row] = await db
		.insert(schema.orders)
		.values({
			storeId: shopify,
			externalId: name,
			name,
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 0,
			sourceUpdatedAt: new Date(),
			...extra,
		})
		.returning();
	const ids = [];
	for (const [i, line] of lines.entries()) {
		const [l] = await db
			.insert(schema.orderLines)
			.values({
				orderId: row.id,
				externalId: `${name}-${i}`,
				productId: wrench,
				title: "Wrench",
				...line,
			})
			.returning();
		ids.push(l.id);
	}
	return { id: row.id, lineIds: ids };
}

async function profit(orderId: number) {
	const [row] = await db
		.select()
		.from(schema.orderProfit)
		.where(eq(schema.orderProfit.orderId, orderId));
	return row;
}

describe("order_profit", () => {
	test("a Shopify order with its fees and Shopify Shipping label", async () => {
		const { id } = await order(
			"#1",
			[{ unitPrice: 20, quantity: 2, unitCost: 8 }],
			{ shippingCharged: 6.5 },
		);
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [
				{ kind: "fee", description: "Processing fee", amount: 1.46 },
				{ kind: "label", description: "Shopify Shipping labels", amount: 5.72 },
			],
		});
		expect(await profit(id)).toMatchObject({
			soldOn: "shopify",
			revenue: 40,
			shippingCharged: 6.5,
			cost: 16,
			costKnown: true,
			fees: 1.46,
			feesStatus: "reported",
			labels: 5.72,
			labelsStatus: "known",
			// 40 + 6.50 - 16 - 1.46 - 5.72
			profit: 23.32,
			complete: true,
		});
	});

	test("until the marketplace reports, fees are estimated and the order incomplete", async () => {
		const { id } = await order(
			"#2",
			[{ unitPrice: 100, quantity: 1, unitCost: 40 }],
			{ storeId: amazon, marketplaceOrderId: "amazon:1" },
		);
		expect(await profit(id)).toMatchObject({
			fees: 15,
			feesStatus: "estimated",
			// Amazon may yet bill a label it sold.
			labelsStatus: "awaiting",
			complete: false,
		});
	});

	test("a relayed TikTok order is TikTok's to bill, not Shopify's", async () => {
		const { id } = await order(
			"#3",
			[{ unitPrice: 50, quantity: 1, unitCost: 20 }],
			{ marketplaceOrderId: "tiktok:577" },
		);
		// Shopify reports it charged nothing; TikTok hasn't settled yet.
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [],
		});
		expect(await profit(id)).toMatchObject({
			soldOn: "tiktok",
			fees: 3,
			feesStatus: "estimated",
		});
		await saveCostReport(db, {
			orderId: id,
			billedBy: "tiktok",
			settled: true,
			charges: [{ kind: "fee", description: "Referral fee", amount: 3.2 }],
		});
		expect(await profit(id)).toMatchObject({ fees: 3.2, feesStatus: "final" });
	});

	test("a katasync label shared by two orders is split by their revenue", async () => {
		const small = await order("#4", [
			{ unitPrice: 10, quantity: 1, unitCost: 4 },
		]);
		const big = await order("#5", [
			{ unitPrice: 30, quantity: 1, unitCost: 12 },
		]);
		await addDispatch(db, {
			orderIds: [small.id, big.id],
			boxes: [{ cost: 8 }],
		});
		expect((await profit(small.id)).labels).toBe(2);
		expect((await profit(big.id)).labels).toBe(6);
		expect((await profit(big.id)).labelsStatus).toBe("known");
	});

	test("voided and test labels cost nothing", async () => {
		const { id } = await order("#6", [
			{ unitPrice: 10, quantity: 1, unitCost: 4 },
		]);
		await addDispatch(db, {
			orderIds: [id],
			boxes: [
				{ cost: 8, voidedAt: new Date() },
				{ cost: 9, test: true },
			],
		});
		// Shopify has reported, so no label from anyone means missing.
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [],
		});
		expect(await profit(id)).toMatchObject({
			labels: 0,
			labelsStatus: "missing",
		});
	});

	test("a TikTok label bought in katasync stands in until TikTok bills it", async () => {
		const { id } = await order(
			"#7",
			[{ unitPrice: 25, quantity: 1, unitCost: 10 }],
			{ marketplaceOrderId: "tiktok:578" },
		);
		await addDispatch(db, {
			orderIds: [id],
			boxes: [{ provider: "tiktok", cost: 6 }],
		});
		expect(await profit(id)).toMatchObject({
			labels: 6,
			labelsStatus: "stand_in",
			complete: false,
		});
		await saveCostReport(db, {
			orderId: id,
			billedBy: "tiktok",
			settled: true,
			charges: [
				{ kind: "fee", description: "Referral fee", amount: 1.5 },
				{ kind: "label", description: "Actual shipping fee", amount: 5.72 },
			],
		});
		// TikTok's own bill replaces the stand-in rather than adding to it.
		expect(await profit(id)).toMatchObject({
			labels: 5.72,
			labelsStatus: "known",
			complete: true,
		});
	});

	test("refunds come off, and units back on the shelf aren't a cost", async () => {
		const { id, lineIds } = await order("#8", [
			{ unitPrice: 20, quantity: 2, unitCost: 8 },
		]);
		await db
			.insert(schema.orderReturns)
			.values({ orderLineId: lineIds[0], quantity: 1, restocked: false });
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			noLabel: true,
			charges: [{ kind: "refund", description: "Refund", amount: 20 }],
		});
		// Written off as damaged: both units' cost stays.
		expect(await profit(id)).toMatchObject({
			cost: 16,
			refunds: 20,
			labelsStatus: "not_needed",
			profit: 4,
		});
	});

	test("units restocked from a return aren't a cost", async () => {
		const { id, lineIds } = await order("#11", [
			{ unitPrice: 20, quantity: 2, unitCost: 8 },
		]);
		await db.insert(schema.orderReturns).values({
			orderLineId: lineIds[0],
			quantity: 1,
			restocked: true,
			batchId: crypto.randomUUID(),
		});
		expect((await profit(id)).cost).toBe(8);
	});

	test("FBA needs no label, and a line without a cost leaves cost unknown", async () => {
		const { id } = await order(
			"#9",
			[
				{ unitPrice: 30, quantity: 1, unitCost: 10 },
				{ unitPrice: 5, quantity: 1, unitCost: null },
			],
			{
				storeId: amazon,
				marketplaceOrderId: "amazon:2",
				fulfilledByChannel: true,
				fulfillmentStatus: "FULFILLMENT_NOT_REQUIRED",
			},
		);
		expect(await profit(id)).toMatchObject({
			labelsStatus: "not_needed",
			costKnown: false,
			complete: false,
		});
	});

	test("a line in before its product had a cost takes the cost it has now", async () => {
		const { id } = await order("#10", [
			{ unitPrice: 30, quantity: 2, unitCost: null },
		]);
		expect(await profit(id)).toMatchObject({ costKnown: false, cost: 0 });
		await db
			.update(schema.products)
			.set({ unitCost: 7 })
			.where(eq(schema.products.id, wrench));
		expect(await profit(id)).toMatchObject({ costKnown: true, cost: 14 });
	});

	test("a tool set's line costs its parts, once every part has a cost", async () => {
		const set = await createProduct(db, "SET", "bundle");
		const blade = await createProduct(db, "BLADE", "simple");
		await db.insert(schema.productComponents).values([
			{ parentProductId: set, componentProductId: wrench, quantity: 1 },
			{ parentProductId: set, componentProductId: blade, quantity: 2 },
		]);
		await db
			.update(schema.products)
			.set({ unitCost: 5 })
			.where(eq(schema.products.id, wrench));
		const { id, lineIds } = await order("#11", [
			{ unitPrice: 40, quantity: 1, unitCost: null },
		]);
		await db
			.update(schema.orderLines)
			.set({ productId: set })
			.where(eq(schema.orderLines.id, lineIds[0]));
		expect((await profit(id)).costKnown).toBe(false);
		await db
			.update(schema.products)
			.set({ unitCost: 3 })
			.where(eq(schema.products.id, blade));
		expect(await profit(id)).toMatchObject({ costKnown: true, cost: 11 });
	});

	test("an order's items add up to its profit", async () => {
		const { id } = await order("#12", [
			{ unitPrice: 30, quantity: 1, unitCost: 10 },
			{ unitPrice: 10, quantity: 3, unitCost: 2 },
		]);
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [
				{ kind: "fee", description: "Processing fee", amount: 2 },
				{ kind: "label", description: "Label", amount: 6 },
			],
		});
		const items = await db
			.select()
			.from(schema.orderLineProfit)
			.where(eq(schema.orderLineProfit.orderId, id));
		// Half the sales each, so half the fees and label each.
		expect(items.map((i) => i.profit).sort()).toEqual([16, 20]);
		expect(items.reduce((sum, i) => sum + i.profit, 0)).toBe(
			(await profit(id)).profit,
		);
	});

	test("an order cancelled down to nothing keeps its lines, so its fee shows", async () => {
		const { id } = await order("#13", [
			{ unitPrice: 20, quantity: 0, unitCost: 5 },
		]);
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [{ kind: "fee", description: "Processing fee", amount: 1.25 }],
		});
		const items = await db
			.select()
			.from(schema.orderLineProfit)
			.where(eq(schema.orderLineProfit.orderId, id));
		expect(items).toMatchObject([{ quantity: 0, profit: -1.25 }]);
		expect((await profit(id)).profit).toBe(-1.25);
	});

	test("a relayed order's refund counts once, from where it sold", async () => {
		const { id } = await order(
			"#12",
			[{ unitPrice: 30, quantity: 1, unitCost: 10 }],
			{
				marketplaceOrderId: "tiktok:579",
			},
		);
		const refund = {
			kind: "refund" as const,
			description: "Refund",
			amount: 30,
		};
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			charges: [refund],
		});
		await saveCostReport(db, {
			orderId: id,
			billedBy: "tiktok",
			settled: true,
			charges: [refund],
		});
		expect((await profit(id)).refunds).toBe(30);
	});

	test("a cancelled order sharing a box leaves its share to the others", async () => {
		const kept = await order("#13", [
			{ unitPrice: 10, quantity: 1, unitCost: 4 },
		]);
		const gone = await order(
			"#14",
			[{ unitPrice: 30, quantity: 1, unitCost: 12 }],
			{
				cancelledAt: new Date(),
			},
		);
		await addDispatch(db, {
			orderIds: [kept.id, gone.id],
			boxes: [{ cost: 8 }],
		});
		expect((await profit(kept.id)).labels).toBe(8);
	});

	test("Shopify's timeline labels stand in until its labels report has them", async () => {
		const { id } = await order("#15", [
			{ unitPrice: 10, quantity: 1, unitCost: 4 },
		]);
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			labelsPending: true,
			charges: [{ kind: "label", description: "Labels", amount: 5.72 }],
		});
		expect(await profit(id)).toMatchObject({
			labels: 5.72,
			labelsStatus: "stand_in",
			complete: false,
		});
	});

	test("cancelled orders aren't in it", async () => {
		const { id } = await order(
			"#10",
			[{ unitPrice: 30, quantity: 1, unitCost: 10 }],
			{
				cancelledAt: new Date(),
			},
		);
		expect(await profit(id)).toBeUndefined();
	});
});

describe("ranges", () => {
	// Friday 8 AM in New York.
	const friday = new Date("2026-10-16T12:00:00Z");

	test("weeks start on Saturday, in the shop's time", async () => {
		expect(await resolveRange(db, "this_week", friday)).toEqual({
			start: new Date("2026-10-10T04:00:00Z"),
			end: friday,
			previousStart: new Date("2026-10-03T04:00:00Z"),
			previousEnd: new Date("2026-10-09T12:00:00Z"),
		});
		// Saturday itself starts a new week.
		const saturday = new Date("2026-10-17T13:00:00Z");
		expect((await resolveRange(db, "this_week", saturday)).start).toEqual(
			new Date("2026-10-17T04:00:00Z"),
		);
		expect((await resolveRange(db, "last_week", saturday)).end).toEqual(
			new Date("2026-10-17T04:00:00Z"),
		);
	});

	test("a month so far compares with last month to the same day", async () => {
		expect(await resolveRange(db, "this_month", friday)).toEqual({
			start: new Date("2026-10-01T04:00:00Z"),
			end: friday,
			previousStart: new Date("2026-09-01T04:00:00Z"),
			previousEnd: new Date("2026-09-16T12:00:00Z"),
		});
		// Late at night in New York is already tomorrow in UTC.
		const lateNight = new Date("2026-11-01T03:30:00Z");
		expect((await resolveRange(db, "this_month", lateNight)).start).toEqual(
			new Date("2026-10-01T04:00:00Z"),
		);
	});
});

describe("totals", () => {
	test("add up profit and say what's unsure", async () => {
		const sure = await order(
			"#a",
			[{ unitPrice: 20, quantity: 1, unitCost: 8 }],
			{
				placedAt: new Date("2026-10-15T15:00:00Z"),
			},
		);
		await saveCostReport(db, {
			orderId: sure.id,
			billedBy: "shopify",
			settled: false,
			noLabel: true,
			charges: [{ kind: "fee", description: "Processing fee", amount: 1 }],
		});
		await order("#b", [{ unitPrice: 100, quantity: 1, unitCost: 40 }], {
			storeId: amazon,
			marketplaceOrderId: "amazon:9",
			placedAt: new Date("2026-10-15T20:00:00Z"),
		});
		const start = new Date("2026-10-15T04:00:00Z");
		const end = new Date("2026-10-16T04:00:00Z");
		expect(await profitTotals(db, start, end)).toMatchObject({
			orders: 2,
			revenue: 120,
			// 11 on the sure one; 100 - 40 - 15 estimated on the other.
			profit: 56,
			complete: 1,
			completeProfit: 11,
			estimatedFees: 15,
			feesEstimated: 1,
			labelsAwaiting: 1,
			labelsMissing: 0,
		});
		const days = await profitByDay(db, start, end);
		expect(days).toEqual([
			{ day: "2026-10-15", revenue: 120, profit: 56, orders: 2 },
		]);
		const [wrenchRow] = await profitByProduct(db, start, end);
		expect(wrenchRow).toMatchObject({
			sku: "WRENCH",
			units: 2,
			profit: 56,
			unsure: 1,
		});
		// #b's label may still come from Amazon; nothing to fix yet.
		expect(await ordersNeedingCosts(db, start, end)).toEqual([]);
	});

	test("a free replacement's costs still land on its products", async () => {
		const free = await order(
			"#free",
			[{ unitPrice: 0, quantity: 1, unitCost: 10 }],
			{ placedAt: new Date("2026-10-15T15:00:00Z") },
		);
		await saveCostReport(db, {
			orderId: free.id,
			billedBy: "shopify",
			settled: false,
			charges: [{ kind: "label", description: "Label", amount: 5 }],
		});
		const start = new Date("2026-10-15T04:00:00Z");
		const end = new Date("2026-10-16T04:00:00Z");
		const [row] = await profitByProduct(db, start, end);
		expect(row.profit).toBe((await profit(free.id)).profit);
		expect(row.profit).toBeLessThan(-10);
	});

	test("items list only what has shipped, and counts what waits", async () => {
		const placedAt = new Date("2026-10-15T15:00:00Z");
		await order("#shipped", [{ unitPrice: 20, quantity: 1, unitCost: 5 }], {
			placedAt,
		});
		await order("#waiting", [{ unitPrice: 20, quantity: 2, unitCost: 5 }], {
			placedAt,
			fulfillmentStatus: "UNFULFILLED",
		});
		const { items, unshipped } = await profitItems(
			db,
			new Date("2026-10-15T04:00:00Z"),
			new Date("2026-10-16T04:00:00Z"),
		);
		expect(items.map((i) => i.orderName)).toEqual(["#shipped"]);
		// Units, as "Items sold" counts them.
		expect(unshipped).toBe(2);
	});
});
