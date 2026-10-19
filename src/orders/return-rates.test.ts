import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { saveCostReport } from "./charges";
import { returnInsights } from "./return-rates";

// The order_line_returns and product_return_rates views
// (drizzle/0064_return_rates.sql, 0065_return_rate_baseline.sql).

let db: Db;
let shopify: number;
let amazon: number;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shopify }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	[{ id: amazon }] = await db
		.insert(schema.stores)
		.values({ channel: "amazon", name: "Amazon US" })
		.returning();
});

async function sale(
	productId: number,
	quantity: number,
	placedAt = daysAgo(90),
	storeId = shopify,
) {
	const externalId = crypto.randomUUID();
	const [o] = await db
		.insert(schema.orders)
		.values({
			storeId,
			externalId,
			name: externalId,
			placedAt,
			fulfillmentStatus: "FULFILLED",
			total: 10 * quantity,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	const [line] = await db
		.insert(schema.orderLines)
		.values({
			orderId: o.id,
			externalId,
			productId,
			title: "Item",
			quantity,
			unitPrice: 10,
		})
		.returning();
	return { orderId: o.id, lineId: line.id };
}

describe("order_line_returns", () => {
	test("counts the most any evidence says came back", async () => {
		const p = await createProduct(db, "WRENCH", "simple");
		const received = await sale(p, 3);
		await db
			.insert(schema.orderReturns)
			.values({ orderLineId: received.lineId, quantity: 1, restocked: false });
		const requested = await sale(p, 3);
		const [r] = await db
			.insert(schema.returnRequests)
			.values({
				orderId: requested.orderId,
				billedBy: "shopify",
				externalId: "R1",
				status: "requested",
				rawStatus: "requested",
				reason: "DEFECTIVE",
				requestedAt: new Date(),
				sourceUpdatedAt: new Date(),
			})
			.returning();
		await db
			.insert(schema.returnRequestLines)
			.values({ requestId: r.id, orderLineId: requested.lineId, quantity: 9 });
		// Refunded in full and kept by the buyer, or partly refunded: only the
		// first is a return.
		const kept = await sale(p, 2);
		const partial = await sale(p, 2);
		for (const [o, amount] of [
			[kept, 20],
			[partial, 5],
		] as const)
			await saveCostReport(db, {
				orderId: o.orderId,
				billedBy: "shopify",
				settled: true,
				noLabel: true,
				charges: [{ kind: "refund", description: "Refund", amount }],
			});

		const rows = await db.select().from(schema.orderLineReturns);
		const of = (id: number) => rows.find((x) => x.lineId === id);
		expect(of(received.lineId)).toMatchObject({ returned: 1, received: 1 });
		expect(of(requested.lineId)).toMatchObject({
			returned: 3,
			reasons: ["DEFECTIVE"],
		});
		expect(of(kept.lineId)).toMatchObject({
			returned: 2,
			refundedInFull: true,
		});
		expect(of(partial.lineId)).toMatchObject({ returned: 0 });
	});
});

const returned = (lineId: number, quantity: number) =>
	db
		.insert(schema.orderReturns)
		.values({ orderLineId: lineId, quantity, restocked: false });

describe("product_return_rates", () => {
	test("tells volume from a high rate, and one return from a pattern", async () => {
		// Sells a lot, returns at the shop's usual rate.
		const popular = await createProduct(db, "POPULAR", "simple");
		for (let i = 0; i < 100; i++) {
			const s = await sale(popular, 10);
			if (i < 2) await returned(s.lineId, 5);
		}
		// Comes back again and again.
		const flaky = await createProduct(db, "FLAKY", "simple");
		for (let i = 0; i < 40; i++) {
			const s = await sale(flaky, 1);
			if (i < 9) await returned(s.lineId, 1);
		}
		// One sale, one return: surprising, but not a pattern.
		const once = await createProduct(db, "ONCE", "simple");
		await returned((await sale(once, 1)).lineId, 1);
		// Too recent to have come back yet, and too old: left out.
		await sale(flaky, 50, daysAgo(10));
		await sale(flaky, 50, daysAgo(500));

		const rows = await db.select().from(schema.productReturnRates);
		const of = (sku: string) => rows.find((r) => r.sku === sku);
		expect(of("POPULAR")).toMatchObject({
			orders: 100,
			ordersReturned: 2,
			sold: 1000,
			returned: 10,
		});
		expect(of("FLAKY")).toMatchObject({ orders: 40, ordersReturned: 9 });
		// Popular returns about what its volume predicts.
		const popularRow = of("POPULAR");
		expect(popularRow?.rateLow).toBeLessThan(popularRow?.baseline ?? 0);
		// Both others clear the bar, but flaky's returns are the ones its sales
		// don't explain.
		const byExcess = rows
			.filter((r) => r.rateLow > r.baseline)
			.sort((a, b) => b.excess - a.excess)
			.map((r) => r.sku);
		expect(byExcess).toEqual(["FLAKY", "ONCE"]);
	});

	test("a box sent back is one return, however many are in it", async () => {
		// Bought by the dozen, or one at a time; 2 of 20 buyers send it back
		// either way.
		const bulk = await createProduct(db, "BULK", "simple");
		const single = await createProduct(db, "SINGLE", "simple");
		for (let i = 0; i < 20; i++) {
			const b = await sale(bulk, 12);
			const s = await sale(single, 1);
			if (i < 2) {
				await returned(b.lineId, 12);
				await returned(s.lineId, 1);
			}
		}
		const rows = await db.select().from(schema.productReturnRates);
		const of = (sku: string) => rows.find((r) => r.sku === sku);
		expect(of("BULK")).toMatchObject({
			ordersReturned: 2,
			returned: 24,
			rate: 0.1,
		});
		expect(of("SINGLE")).toMatchObject({
			ordersReturned: 2,
			returned: 2,
			rate: 0.1,
		});
		expect(of("BULK")?.rateLow).toBe(of("SINGLE")?.rateLow);
	});

	test("holds each product to the channels it sold on", async () => {
		// Amazon names every return; Shopify only shows full refunds. A product
		// at Amazon's usual rate isn't returned too often.
		const shopifyOnly = await createProduct(db, "SHOPIFY-ONLY", "simple");
		for (let i = 0; i < 100; i++) await sale(shopifyOnly, 1);
		const amazonOnly = await createProduct(db, "AMAZON-ONLY", "simple");
		for (let i = 0; i < 100; i++) {
			const s = await sale(amazonOnly, 1, daysAgo(90), amazon);
			if (i < 5) await returned(s.lineId, 1);
		}
		const [row] = (await db.select().from(schema.productReturnRates)).filter(
			(r) => r.sku === "AMAZON-ONLY",
		);
		expect(row).toMatchObject({ baseline: 0.05, expected: 5, excess: 0 });
	});
});

describe("returnInsights", () => {
	test("counts the same window as the view, and splits flagged from expected", async () => {
		const flaky = await createProduct(db, "FLAKY", "simple");
		const steady = await createProduct(db, "STEADY", "simple");
		for (let i = 0; i < 40; i++) {
			const s = await sale(flaky, 1);
			if (i < 9) await returned(s.lineId, 1);
		}
		for (let i = 0; i < 200; i++) {
			const s = await sale(steady, 1);
			if (i < 3) await returned(s.lineId, 1);
		}
		// Just outside each end of the window.
		await sale(flaky, 7, daysAgo(44));
		await sale(flaky, 7, daysAgo(411));
		// Sold once, came back once: high, but not a pattern.
		const once = await createProduct(db, "ONCE", "simple");
		await returned((await sale(once, 1)).lineId, 1);

		const insights = await returnInsights(db);
		const view = await db.select().from(schema.productReturnRates);
		const sum = (rows: { sold: number }[]) =>
			rows.reduce((n, r) => n + r.sold, 0);
		expect(sum(insights.channels)).toBe(sum(view));
		expect(insights.flagged.map((r) => r.sku)).toEqual(["FLAKY"]);
		expect(insights.once.map((r) => r.sku)).toEqual(["ONCE"]);
		expect(insights.expected.map((r) => r.sku)).toEqual(["STEADY"]);
		expect(insights.lines.filter((l) => l.productId === flaky)).toHaveLength(9);
	});
});
