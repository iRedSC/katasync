import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { returnStages } from "./return-stage";
import { orderStatus } from "./status";

const base = {
	cancelledAt: null,
	fulfillmentStatus: "UNFULFILLED",
	financialStatus: "PAID",
	channel: "shopify",
	salesChannel: "Online Store",
	marketplaceOrderId: null,
	externalId: "gid://shopify/Order/1",
	shipCountry: "US",
	labelToVoid: false,
	fulfilledByChannel: false,
	returnStage: null,
} as const;
const keyOf = (over: Partial<Parameters<typeof orderStatus>[0]>) =>
	orderStatus({ ...base, ...over }).key;

describe("orderStatus", () => {
	test("to ship here is yellow; to ship on the marketplace links there", () => {
		expect(orderStatus(base)).toMatchObject({
			key: "unfulfilled",
			label: "Unfulfilled",
			tone: "warning",
		});
		expect(keyOf({ fulfillmentStatus: "PARTIALLY_FULFILLED" })).toBe(
			"unfulfilled",
		);
		expect(
			orderStatus({
				...base,
				channel: "amazon",
				marketplaceOrderId: "amazon:111-1",
			}),
		).toMatchObject({
			key: "external",
			label: "Unfulfilled",
			tone: "info",
			on: "Amazon",
			url: expect.stringContaining("111-1"),
		});
	});

	test("waiting on payment or a hold is pending", () => {
		expect(keyOf({ fulfillmentStatus: "AWAITING_PAYMENT" })).toBe("pending");
		expect(keyOf({ fulfillmentStatus: "ON_HOLD" })).toBe("pending");
	});

	test("shipped or needing none is fulfilled; restocked is cancelled", () => {
		expect(keyOf({ fulfillmentStatus: "FULFILLED" })).toBe("fulfilled");
		expect(keyOf({ fulfillmentStatus: "FULFILLMENT_NOT_REQUIRED" })).toBe(
			"fulfilled",
		);
		expect(keyOf({ fulfillmentStatus: "RESTOCKED" })).toBe("cancelled");
	});

	test("Amazon's own stock is FBA fulfilled, never ours to ship", () => {
		const fba = {
			channel: "amazon",
			marketplaceOrderId: "amazon:111-1",
			fulfilledByChannel: true,
		};
		expect(orderStatus({ ...base, ...fba })).toMatchObject({
			key: "fba",
			label: "FBA Fulfilled",
		});
		expect(keyOf({ ...fba, fulfillmentStatus: "FULFILLED" })).toBe("fba");
		expect(keyOf({ ...fba, cancelledAt: new Date() })).toBe("cancelled");
	});

	test("a return outranks its refund; a live label outranks everything", () => {
		const refunded = {
			fulfillmentStatus: "FULFILLED",
			financialStatus: "REFUNDED",
		};
		expect(keyOf(refunded)).toBe("refunded");
		expect(keyOf({ ...refunded, returnStage: "returning" })).toBe("returning");
		expect(keyOf({ ...refunded, returnStage: "returned" })).toBe("returned");
		expect(
			keyOf({ ...refunded, returnStage: "returning", labelToVoid: true }),
		).toBe("void");
		expect(keyOf({ cancelledAt: new Date() })).toBe("cancelled");
	});
});

describe("returnStages", () => {
	let db: Db;
	let store: number;
	let wrench: number;
	beforeEach(async () => {
		db = await createTestDb();
		[{ id: store }] = await db
			.insert(schema.stores)
			.values({ channel: "shopify", name: "Shopify" })
			.returning();
		wrench = await createProduct(db, "WRENCH", "simple");
	});

	async function shipped(name: string) {
		const [o] = await db
			.insert(schema.orders)
			.values({
				storeId: store,
				externalId: name,
				name,
				placedAt: new Date(),
				fulfillmentStatus: "FULFILLED",
				total: 0,
				sourceUpdatedAt: new Date(),
			})
			.returning();
		const [l] = await db
			.insert(schema.orderLines)
			.values({
				orderId: o.id,
				externalId: `${name}-0`,
				productId: wrench,
				sku: "WRENCH",
				title: "Wrench",
				quantity: 2,
				unitPrice: 20,
				unitCost: 8,
				saleBatchId: crypto.randomUUID(),
			})
			.returning();
		return { id: o.id, lineId: l.id };
	}

	const requestReturn = async (o: { id: number; lineId: number }) => {
		const [r] = await db
			.insert(schema.returnRequests)
			.values({
				orderId: o.id,
				billedBy: "shopify",
				externalId: crypto.randomUUID(),
				status: "requested",
				rawStatus: "requested",
				requestedAt: new Date(),
				sourceUpdatedAt: new Date(),
			})
			.returning();
		await db
			.insert(schema.returnRequestLines)
			.values({ requestId: r.id, orderLineId: o.lineId, quantity: 1 });
	};
	const receive = (o: { lineId: number }) =>
		db
			.insert(schema.orderReturns)
			.values({ orderLineId: o.lineId, quantity: 1, restocked: false });

	test("returning while due back, returned once received, none without", async () => {
		const asked = await shipped("#1");
		await requestReturn(asked);
		const back = await shipped("#2");
		await requestReturn(back);
		await receive(back);
		const kept = await shipped("#3");
		const stages = await returnStages(db, [asked.id, back.id, kept.id]);
		expect(stages.get(asked.id)).toBe("returning");
		expect(stages.get(back.id)).toBe("returned");
		expect(stages.has(kept.id)).toBe(false);
	});
});
