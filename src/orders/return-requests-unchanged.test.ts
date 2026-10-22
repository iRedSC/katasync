import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { type ChannelReturn, saveReturns } from "./return-requests";

describe("saveReturns skips returns that haven't changed", () => {
	let db: Db;
	let store: typeof schema.stores.$inferSelect;

	beforeEach(async () => {
		db = await createTestDb();
		[store] = await db
			.insert(schema.stores)
			.values({ channel: "amazon", name: "Amazon US" })
			.returning();
		const product = await createProduct(db, "WRENCH", "simple");
		const [o] = await db
			.insert(schema.orders)
			.values({
				storeId: store.id,
				externalId: "111-1",
				name: "111-1",
				placedAt: new Date(),
				fulfillmentStatus: "Shipped",
				total: 20,
				sourceUpdatedAt: new Date(),
			})
			.returning();
		await db.insert(schema.orderLines).values({
			orderId: o.id,
			externalId: "OI-1",
			productId: product,
			sku: "WRENCH",
			title: "Wrench",
			quantity: 1,
			unitPrice: 20,
		});
	});

	// A fixed requestedAt, so two reads of the same return compare equal.
	const ret: ChannelReturn = {
		externalId: "RMA1",
		orderExternalId: "111-1",
		status: "requested",
		rawStatus: "requested",
		reason: "DEFECTIVE",
		note: "Leaks from the bottom",
		trackingNumber: null,
		carrier: null,
		requestedAt: new Date("2026-10-20T12:00:00Z"),
		lines: [{ lineExternalId: "OI-1", sku: "WRENCH", quantity: 1 }],
	};

	test("an identical return is not written again, a changed one is", async () => {
		const transaction = vi.spyOn(db, "transaction");
		await saveReturns(db, store, [ret]);
		expect(transaction).toHaveBeenCalledTimes(1);
		await saveReturns(db, store, [ret]);
		expect(transaction).toHaveBeenCalledTimes(1);
		await saveReturns(db, store, [{ ...ret, status: "closed" }]);
		expect(transaction).toHaveBeenCalledTimes(2);
	});

	test("a line that gets its order line later is reconciled on an unchanged return", async () => {
		const [o2] = await db
			.insert(schema.orders)
			.values({
				storeId: store.id,
				externalId: "222-2",
				name: "222-2",
				placedAt: new Date(),
				fulfillmentStatus: "Shipped",
				total: 20,
				sourceUpdatedAt: new Date(),
			})
			.returning();
		const late = { ...ret, externalId: "RMA2", orderExternalId: "222-2" };
		await saveReturns(db, store, [late]);
		const transaction = vi.spyOn(db, "transaction");
		await db.insert(schema.orderLines).values({
			orderId: o2.id,
			externalId: "OI-2",
			sku: "WRENCH",
			title: "Wrench",
			quantity: 1,
			unitPrice: 20,
		});
		await saveReturns(db, store, [late]);
		expect(transaction).toHaveBeenCalledTimes(1);
		const lines = await db.select().from(schema.returnRequestLines);
		expect(lines).toMatchObject([{ orderLineId: expect.any(Number) }]);
	});
});
