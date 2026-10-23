import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import { saveCostReport } from "./charges";
import { type ProfitFixture, profitFixture } from "./profit.fixtures";

let db: Db;
let amazon: number;
let wrench: number;
let order: ProfitFixture["order"];
let profit: ProfitFixture["profit"];

beforeEach(async () => {
	({ db, amazon, wrench, order, profit } = await profitFixture());
});

describe("order_profit", () => {
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

	test("a line in before its product had a cost takes its first cost", async () => {
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
