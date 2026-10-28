import { eq } from "drizzle-orm";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";

// The order_profit view (drizzle/0050_order_profit.sql).

export async function profitFixture() {
	const db = await createTestDb();
	const [{ id: shopify }, { id: amazon }] = await db
		.insert(schema.stores)
		.values([
			{ channel: "shopify", name: "Shopify" },
			{ channel: "amazon", name: "Amazon US" },
		])
		.returning();
	const wrench = await createProduct(db, "WRENCH", "simple");

	async function order(
		name: string,
		lines: {
			unitPrice: number;
			quantity: number;
			unitCost: number | null;
			saleBatchId?: string;
			// The wrench unless given.
			productId?: number;
		}[],
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

	return { db, shopify, amazon, wrench, order, profit };
}

export type ProfitFixture = Awaited<ReturnType<typeof profitFixture>>;
