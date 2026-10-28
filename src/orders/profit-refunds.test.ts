import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { saveCostReport } from "./charges";
import { committedOrder } from "./committed-order.fixtures";
import { type ProfitFixture, profitFixture } from "./profit.fixtures";

let db: Db;
let order: ProfitFixture["order"];
let profit: ProfitFixture["profit"];
let shopify: number;
let wrench: number;

beforeEach(async () => {
	({ db, order, profit, shopify, wrench } = await profitFixture());
});

describe("order_profit", () => {
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

	test("a full refund's items cost nothing until they're back or written off", async () => {
		const { id, lineIds } = await order("#12", [
			{
				unitPrice: 20,
				quantity: 2,
				unitCost: 8,
				saleBatchId: crypto.randomUUID(),
			},
		]);
		await saveCostReport(db, {
			orderId: id,
			billedBy: "shopify",
			settled: false,
			noLabel: true,
			charges: [{ kind: "refund", description: "Refund", amount: 40 }],
		});
		expect(await profit(id)).toMatchObject({
			cost: 0,
			profit: 0,
			awaitingReturn: true,
			complete: false,
		});
		const [line] = await db
			.select()
			.from(schema.orderLineProfit)
			.where(eq(schema.orderLineProfit.orderId, id));
		expect(line).toMatchObject({ returning: 2, cost: 0, complete: false });

		// One came back damaged: it costs what it did; the other is still out.
		await db
			.insert(schema.orderReturns)
			.values({ orderLineId: lineIds[0], quantity: 1, restocked: false });
		expect(await profit(id)).toMatchObject({ cost: 8, awaitingReturn: true });

		// The other went back on the shelf: settled, nothing more to count.
		await db.insert(schema.orderReturns).values({
			orderLineId: lineIds[0],
			quantity: 1,
			restocked: true,
			batchId: crypto.randomUUID(),
		});
		expect(await profit(id)).toMatchObject({
			cost: 8,
			awaitingReturn: false,
			complete: true,
		});
	});

	test("a refund awaits no return when it's partial, old, FBA, or nothing left the shelf", async () => {
		const sale = () => crypto.randomUUID();
		const cases = [
			// Part of what it sold for: a discount, or one item of several.
			{ refund: 10, line: { saleBatchId: sale() }, extra: {} },
			// Its shipping refunded with part of the items.
			{
				refund: 40,
				line: { saleBatchId: sale() },
				extra: { shippingCharged: 10 },
			},
			// Past when any return would have arrived.
			{
				refund: 40,
				line: { saleBatchId: sale() },
				extra: { placedAt: new Date(Date.now() - 61 * 86_400_000) },
			},
			// Amazon takes FBA returns back itself.
			{
				refund: 40,
				line: { saleBatchId: sale() },
				extra: { fulfilledByChannel: true },
			},
			// Never took stock, so nothing is coming back to us.
			{ refund: 40, line: {}, extra: {} },
		];
		for (const [i, c] of cases.entries()) {
			const { id } = await order(
				`#r${i}`,
				[{ unitPrice: 20, quantity: 2, unitCost: 8, ...c.line }],
				c.extra,
			);
			await saveCostReport(db, {
				orderId: id,
				billedBy: "shopify",
				settled: false,
				noLabel: true,
				charges: [{ kind: "refund", description: "Refund", amount: c.refund }],
			});
			expect(await profit(id), `case ${i}`).toMatchObject({
				cost: 16,
				awaitingReturn: false,
			});
		}
	});

	test("with committed stock, a full refund awaits only the units that shipped", async () => {
		// Two of three shipped; a third shipped and was put back.
		const { orderId } = await committedOrder(db, { id: shopify, wrench }, 2);
		await saveCostReport(db, {
			orderId,
			billedBy: "shopify",
			settled: false,
			noLabel: true,
			charges: [{ kind: "refund", description: "Refund", amount: 70 }],
		});
		expect(await profit(orderId)).toMatchObject({
			cost: 8,
			awaitingReturn: true,
		});
		const [line] = await db
			.select()
			.from(schema.orderLineProfit)
			.where(eq(schema.orderLineProfit.orderId, orderId));
		expect(line).toMatchObject({ returning: 2, cost: 8 });
	});

	test("with committed stock, a refund awaits nothing when nothing shipped", async () => {
		const { orderId } = await committedOrder(db, { id: shopify, wrench }, 0);
		await saveCostReport(db, {
			orderId,
			billedBy: "shopify",
			settled: false,
			noLabel: true,
			charges: [{ kind: "refund", description: "Refund", amount: 70 }],
		});
		expect(await profit(orderId)).toMatchObject({
			cost: 24,
			awaitingReturn: false,
		});
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
});
