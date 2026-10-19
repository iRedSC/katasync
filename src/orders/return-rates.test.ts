import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { saveCostReport } from "./charges";

// The order_line_returns and product_return_rates views
// (drizzle/0064_return_rates.sql).

let db: Db;
let shopify: number;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shopify }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
});

async function sale(
	productId: number,
	quantity: number,
	placedAt = daysAgo(90),
) {
	const externalId = crypto.randomUUID();
	const [o] = await db
		.insert(schema.orders)
		.values({
			storeId: shopify,
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

describe("product_return_rates", () => {
	test("tells volume from a high rate", async () => {
		// Sells a lot, returns at the shop's usual rate.
		const popular = await createProduct(db, "POPULAR", "simple");
		for (let i = 0; i < 20; i++) {
			const s = await sale(popular, 10);
			if (i < 2)
				await db.insert(schema.orderReturns).values({
					orderLineId: s.lineId,
					quantity: 5,
					restocked: true,
					batchId: crypto.randomUUID(),
				});
		}
		// Sells little, comes back half the time.
		const flaky = await createProduct(db, "FLAKY", "simple");
		for (let i = 0; i < 10; i++) {
			const s = await sale(flaky, 2);
			if (i < 5)
				await db
					.insert(schema.orderReturns)
					.values({ orderLineId: s.lineId, quantity: 2, restocked: false });
		}
		// Too recent to have come back yet, and too old: left out.
		await sale(flaky, 50, daysAgo(10));
		await sale(flaky, 50, daysAgo(500));

		const rows = await db.select().from(schema.productReturnRates);
		const of = (sku: string) => rows.find((r) => r.sku === sku);
		expect(of("POPULAR")).toMatchObject({
			sold: 200,
			returned: 10,
			restocked: 10,
		});
		expect(of("FLAKY")).toMatchObject({ sold: 20, returned: 10, rate: 0.5 });
		const shopRate = of("FLAKY")?.shopRate ?? 0;
		expect(shopRate).toBeCloseTo(20 / 220, 4);
		// Popular returns about what its volume predicts; flaky stays above the
		// shop's rate even at its lowest likely rate.
		expect(of("POPULAR")?.rateLow).toBeLessThan(shopRate);
		expect(of("FLAKY")?.rateLow).toBeGreaterThan(shopRate);
		expect(of("POPULAR")?.expected).toBeCloseTo(18.2, 1);
	});
});
