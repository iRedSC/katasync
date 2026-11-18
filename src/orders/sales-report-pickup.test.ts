import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { type ChannelOrder, ingestOrder } from "./ingest";
import { readSalesReport } from "./sales-report";

let db: Db;
let storeId: number;

const order = (n: number, extra: Partial<ChannelOrder>): ChannelOrder => ({
	externalId: `gid://shopify/Order/${n}`,
	name: `#${n}`,
	salesChannel: "Online Store",
	marketplaceOrderId: null,
	placedAt: new Date("2026-10-05T12:00:00Z"),
	cancelledAt: null,
	fulfillmentStatus: "FULFILLED",
	fulfilledByChannel: false,
	soldInStore: false,
	pickup: false,
	financialStatus: "PAID",
	customerName: "Pat Doe",
	buyerId: null,
	shipCity: "Columbus",
	shipRegion: "OH",
	shipCountry: "US",
	shipAddress1: "1 Main St",
	shipAddress2: null,
	shipPostalCode: "43004",
	shipPhone: null,
	total: 20,
	shippingCharged: 0,
	tax: { remittedBy: "seller", lines: [] },
	sourceUpdatedAt: new Date("2026-10-05T12:00:00Z"),
	lines: [
		{
			externalId: `gid://shopify/LineItem/${n}`,
			listingExternalId: null,
			sku: "WRENCH",
			title: "Wrench",
			quantity: 1,
			shipped: 1,
			unitPrice: 20,
		},
	],
	...extra,
});

beforeEach(async () => {
	db = await createTestDb();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	await createProduct(db, "WRENCH", "simple");
});

test("a pickup is sold here, whatever address it carries", async () => {
	const store = { id: storeId, stockFrom: null };
	const from = { shipping: null, store: null, pos: null, storeKeeps: 0 };
	await ingestOrder(db, store, order(1, {}), from);
	await ingestOrder(db, store, order(2, { pickup: true }), from);
	const { states } = await readSalesReport(db, { year: 2026, month: 10 });
	expect(states.map((s) => [s.how, s.state, s.orders]).sort()).toEqual([
		["no_address", null, 1],
		["shipped", "OH", 1],
	]);
});
