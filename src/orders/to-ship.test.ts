import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { saveCostReport } from "./charges";
import { financialStatus, needsShipping } from "./to-ship";

test("an Amazon order refunded in full stops needing shipping, though Amazon still says paid", async () => {
	const db = await createTestDb();
	const [{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "amazon", name: "Amazon" })
		.returning();
	const [{ id: orderId }] = await db
		.insert(schema.orders)
		.values({
			storeId,
			externalId: "114-1",
			name: "114-1",
			marketplaceOrderId: "amazon:114-1",
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			financialStatus: "PAID",
			total: 50,
			shippingCharged: 5,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	await db.insert(schema.orderLines).values({
		orderId,
		externalId: "line-1",
		sku: "WRENCH",
		title: "Wrench",
		quantity: 3,
		unitPrice: 15,
	});
	const read = async () =>
		(
			await db
				.select({ financialStatus, needsShipping })
				.from(schema.orders)
				.where(eq(schema.orders.id, orderId))
		)[0];
	const refunded = (...amounts: number[]) =>
		saveCostReport(db, {
			orderId,
			billedBy: "amazon",
			settled: false,
			charges: amounts.map((amount) => ({
				kind: "refund",
				description: "Refund",
				amount,
			})),
		});

	expect(await read()).toEqual({
		financialStatus: "PAID",
		needsShipping: true,
	});
	// Every item, but not the shipping.
	await refunded(30, 15);
	expect(await read()).toEqual({
		financialStatus: "PAID",
		needsShipping: true,
	});
	await refunded(30, 15, 5);
	expect(await read()).toEqual({
		financialStatus: "REFUNDED",
		needsShipping: false,
	});
});
