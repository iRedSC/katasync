import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	parseReturnsReport,
	returnStatus,
	saveAmazonReturns,
} from "./amazon-returns";

const HEADER = [
	"Order ID",
	"Order date",
	"Return request date",
	"Return request status",
	"Amazon RMA ID",
	"Tracking ID",
	"Return carrier",
	"Merchant SKU",
	"Return quantity",
	"Return Reason",
	"Return delivery date",
	"Order Item ID",
].join("\t");

const row = (cells: Partial<Record<string, string>>) =>
	HEADER.split("\t")
		.map((c) => cells[c] ?? "")
		.join("\t");

describe("parseReturnsReport", () => {
	test("groups an RMA's items and reads its stage", () => {
		const { returns, problems } = parseReturnsReport(
			[
				`﻿${HEADER}`,
				row({
					"Order ID": "111-1",
					"Return request date": "2026-09-01T10:00:00Z",
					"Return request status": "Approved",
					"Amazon RMA ID": "RMA1",
					"Tracking ID": "1Z9",
					"Merchant SKU": "WRENCH",
					"Return quantity": "1",
					"Return Reason": "DEFECTIVE",
					"Order Item ID": "OI-1",
				}),
				row({
					"Order ID": "111-1",
					"Return request date": "2026-09-01T10:00:00Z",
					"Return request status": "Approved",
					"Amazon RMA ID": "RMA1",
					"Merchant SKU": "HAWK",
					"Return quantity": "2",
					"Order Item ID": "OI-2",
				}),
				row({
					"Order ID": "111-2",
					"Return request date": "soon",
					"Return quantity": "1",
				}),
				"",
			].join("\n"),
		);
		expect(problems).toEqual(["Amazon return for 111-2 has no date"]);
		expect(returns).toHaveLength(1);
		expect(returns[0]).toMatchObject({
			rmaId: "RMA1",
			status: "shipped",
			reason: "DEFECTIVE",
			lines: [
				{ orderItemId: "OI-1", sku: "WRENCH", quantity: 1 },
				{ orderItemId: "OI-2", sku: "HAWK", quantity: 2 },
			],
		});
	});

	test("a renamed column fails instead of reading as blank", () => {
		expect(() => parseReturnsReport("Order ID\tReturn date\n")).toThrow(
			"has no Return request date",
		);
	});

	test("statuses", () => {
		const s = (status: string, delivered = false, tracked = false) =>
			returnStatus({ status, delivered, tracked });
		expect(s("Rejected", true)).toBe("cancelled");
		expect(s("Closed", true)).toBe("closed");
		expect(s("Approved", true, true)).toBe("delivered");
		expect(s("Pending")).toBe("requested");
	});
});

describe("saveAmazonReturns", () => {
	let db: Db;
	let store: number;
	let lineId: number;

	beforeEach(async () => {
		db = await createTestDb();
		[{ id: store }] = await db
			.insert(schema.stores)
			.values({ channel: "amazon", name: "Amazon US" })
			.returning();
		const product = await createProduct(db, "WRENCH", "simple");
		const [o] = await db
			.insert(schema.orders)
			.values({
				storeId: store,
				externalId: "111-1",
				name: "111-1",
				placedAt: new Date(),
				fulfillmentStatus: "Shipped",
				total: 20,
				sourceUpdatedAt: new Date(),
			})
			.returning();
		[{ id: lineId }] = await db
			.insert(schema.orderLines)
			.values({
				orderId: o.id,
				externalId: "OI-1",
				productId: product,
				sku: "WRENCH",
				title: "Wrench",
				quantity: 1,
				unitPrice: 20,
			})
			.returning();
	});

	const amazonReturn = (status: "requested" | "closed") => ({
		rmaId: "RMA1",
		orderId: "111-1",
		rawStatus: status,
		status,
		reason: "DEFECTIVE",
		trackingNumber: null,
		carrier: null,
		requestedAt: new Date(),
		lines: [{ orderItemId: "OI-1", sku: "WRENCH", quantity: 1 }],
	});

	test("saves against the order's line, and a later report replaces it", async () => {
		const unknown = {
			...amazonReturn("requested"),
			rmaId: "RMA2",
			orderId: "999",
		};
		expect(
			await saveAmazonReturns(db, store, [amazonReturn("requested"), unknown]),
		).toEqual({
			saved: 1,
			skipped: 1,
		});
		await saveAmazonReturns(db, store, [amazonReturn("closed")]);

		const requests = await db.select().from(schema.returnRequests);
		expect(requests).toMatchObject([{ status: "closed", reason: "DEFECTIVE" }]);
		const lines = await db
			.select()
			.from(schema.returnRequestLines)
			.where(eq(schema.returnRequestLines.requestId, requests[0].id));
		expect(lines).toMatchObject([{ orderLineId: lineId, quantity: 1 }]);
	});
});
