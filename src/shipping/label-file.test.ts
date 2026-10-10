import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { labelPdf } from "./label-file";

let db: Db;
let shipmentId: number;

beforeEach(async () => {
	db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: "o1",
			name: "#1",
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 10,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	[{ id: shipmentId }] = await db
		.insert(schema.shipments)
		.values({
			orderId: order.id,
			contentsKey: "X×1",
			lengthMm: 1,
			widthMm: 1,
			heightMm: 1,
			weightGrams: 1,
			provider: "shippo",
			carrier: "USPS",
			service: "usps_ground_advantage",
			serviceName: "USPS Ground Advantage",
			cost: 5,
			labelUrl: "https://shippo.example/label.pdf",
			externalId: "tx1",
			test: false,
		})
		.returning();
});

afterEach(() => vi.unstubAllGlobals());

describe("labelPdf", () => {
	test("downloads a label once, then prints from the saved copy", async () => {
		const download = vi.fn(async () => new Response("%PDF-label"));
		vi.stubGlobal("fetch", download);

		expect((await labelPdf(db, shipmentId)).toString()).toBe("%PDF-label");
		expect((await labelPdf(db, shipmentId)).toString()).toBe("%PDF-label");
		expect(download).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledWith("https://shippo.example/label.pdf");
	});

	test("a failed download saves nothing, so the next print tries again", async () => {
		vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
		await expect(labelPdf(db, shipmentId)).rejects.toThrow("404");

		vi.stubGlobal("fetch", async () => new Response("%PDF-label"));
		expect((await labelPdf(db, shipmentId)).toString()).toBe("%PDF-label");
	});
});
