import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { addDispatch, createProduct, createTestDb } from "#/test/db";
import { saveCostReport } from "./charges";

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
			labelsStatus: "missing",
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
