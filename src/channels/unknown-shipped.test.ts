import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { rereadUnknownShipped } from "./unknown-shipped";

let db: Db;
let storeId: number;

// An open order whose one line's shipped count is unknown.
async function unknown(n: number) {
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId,
			externalId: `order-${n}`,
			name: `#${n}`,
			placedAt: new Date("2026-10-01T00:00:00Z"),
			fulfillmentStatus: "PARTIALLY_FULFILLED",
			total: 10,
			sourceUpdatedAt: new Date("2026-10-01T00:00:00Z"),
			// Oldest synced first, so the first ten are the ones picked first.
			syncedAt: new Date(Date.UTC(2026, 9, 1, 0, n)),
		})
		.returning();
	await db.insert(schema.orderLines).values({
		orderId: order.id,
		externalId: `line-${n}`,
		sku: "WRENCH",
		title: "Wrench",
		quantity: 2,
		unitPrice: 5,
		shippedQuantity: null,
	});
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
});

describe("rereadUnknownShipped", () => {
	test("orders that keep failing go to the back, so the rest still get asked", async () => {
		for (let n = 1; n <= 11; n++) await unknown(n);
		const asked: string[][] = [];
		const pass = async () => {
			const names: string[] = [];
			const problems = await rereadUnknownShipped(
				db,
				storeId,
				new Date(),
				async (order) => {
					names.push(order.name);
					// The first ten never read; nothing about them changes.
					throw new Error("503");
				},
			);
			asked.push(names);
			return problems;
		};

		expect(await pass()).toHaveLength(10);
		expect(asked[0]).not.toContain("#11");
		await pass();
		expect(asked[1]).toContain("#11");
	});
});
