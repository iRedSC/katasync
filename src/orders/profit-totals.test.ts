import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { saveCostReport } from "./charges";
import {
	ordersNeedingCosts,
	ordersWaiting,
	profitByDay,
	profitByProduct,
	profitItems,
	profitTotals,
} from "./profit";
import { type ProfitFixture, profitFixture } from "./profit.fixtures";

let db: Db;
let amazon: number;
let order: ProfitFixture["order"];
let profit: ProfitFixture["profit"];

beforeEach(async () => {
	({ db, amazon, order, profit } = await profitFixture());
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

	test("an Amazon order not confirmed yet stays out, FBA or not", async () => {
		const placedAt = new Date("2026-10-15T15:00:00Z");
		await order("#paid", [{ unitPrice: 30, quantity: 1, unitCost: 10 }], {
			placedAt,
		});
		await order("#pending", [{ unitPrice: 0, quantity: 1, unitCost: 10 }], {
			placedAt,
			storeId: amazon,
			marketplaceOrderId: "amazon:pending",
			fulfilledByChannel: true,
			fulfillmentStatus: "AWAITING_PAYMENT",
		});
		const start = new Date("2026-10-15T04:00:00Z");
		const end = new Date("2026-10-16T04:00:00Z");
		expect(await profitTotals(db, start, end)).toMatchObject({
			orders: 1,
			revenue: 30,
		});
		expect(await ordersWaiting(db, start, end)).toBe(1);
		const { items } = await profitItems(db, start, end);
		expect(items.map((i) => i.orderName)).toEqual(["#paid"]);
	});
});
