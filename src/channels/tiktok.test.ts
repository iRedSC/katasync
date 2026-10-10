import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { createProduct, createTestDb } from "#/test/db";
import { takeOver } from "./tiktok";

let db: Db;
let warehouse: number;
let shopify: { id: number; stockFrom: Date };
let tiktok: { id: number; stockFrom: Date };
let wrench: number;
const stockFrom = new Date("2026-10-01T00:00:00Z");

const base = {
	marketplaceOrderId: "tiktok:577",
	salesChannel: "TikTok",
	placedAt: new Date("2026-10-05T12:00:00Z"),
	cancelledAt: null,
	fulfillmentStatus: "UNFULFILLED",
	fulfilledByChannel: false,
	financialStatus: "PAID",
	customerName: null,
	shipAddress1: null,
	shipAddress2: null,
	shipCity: null,
	shipRegion: "TX",
	shipPostalCode: null,
	shipCountry: "US",
	shipPhone: null,
	total: 40,
	shippingCharged: 0,
	sourceUpdatedAt: new Date("2026-10-05T12:00:00Z"),
};

// How Shopify's TikTok channel relayed it.
const relayed: ChannelOrder = {
	...base,
	externalId: "gid://shopify/Order/5546",
	name: "#5546",
	lines: [
		{
			externalId: "gid://shopify/LineItem/1",
			listingExternalId: "gid://shopify/ProductVariant/1",
			sku: "WRENCH",
			title: "Wrench",
			quantity: 2,
			unitPrice: 20,
		},
	],
};

// The same sale as TikTok reports it.
const direct = (extra: Partial<ChannelOrder> = {}): ChannelOrder => ({
	...base,
	externalId: "577",
	name: "577",
	lines: [
		{
			externalId: "1729",
			listingExternalId: "1729",
			// SKUs match however they're capitalized.
			sku: "wrench",
			title: "Wrench",
			quantity: 2,
			unitPrice: 20,
		},
	],
	...extra,
});

async function onHand() {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, wrench));
	return row?.onHand ?? 0;
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	const [s, t] = await db
		.insert(schema.stores)
		.values([
			{ channel: "shopify", name: "Shopify", stockFrom },
			{ channel: "tiktok", name: "TikTok Shop", stockFrom },
		])
		.returning();
	shopify = { id: s.id, stockFrom };
	tiktok = { id: t.id, stockFrom };
	wrench = await createProduct(db, "WRENCH", "simple");
	await postMovements(db, {
		lines: [
			{
				productId: wrench,
				locationId: warehouse,
				delta: 10,
				reason: "opening_balance",
			},
		],
	});
	await ingestOrder(db, shopify, relayed, warehouse);
	await db
		.update(schema.orders)
		.set({ pin: 49 })
		.where(eq(schema.orders.externalId, relayed.externalId));
});

describe("takeOver", () => {
	test("moves a relayed order to TikTok without taking stock again", async () => {
		expect(await onHand()).toBe(8);
		const order = direct({ fulfillmentStatus: "FULFILLED" });
		expect(await takeOver(db, tiktok.id, order)).toEqual([]);
		await ingestOrder(db, tiktok, order, warehouse);

		expect(await onHand()).toBe(8);
		const [saved] = await db.select().from(schema.orders);
		expect(saved).toMatchObject({
			storeId: tiktok.id,
			externalId: "577",
			fulfillmentStatus: "FULFILLED",
			pin: 49,
		});
		const lines = await db.select().from(schema.orderLines);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ externalId: "1729", quantity: 2 });
	});

	test("a cancellation after the move gives the stock back", async () => {
		await takeOver(db, tiktok.id, direct());
		await ingestOrder(db, tiktok, direct(), warehouse);
		await ingestOrder(
			db,
			tiktok,
			direct({ cancelledAt: new Date("2026-10-06T00:00:00Z") }),
			warehouse,
		);
		expect(await onHand()).toBe(10);
	});

	test("does nothing to an order only TikTok has", async () => {
		const other = direct({ marketplaceOrderId: "tiktok:999" });
		expect(await takeOver(db, tiktok.id, other)).toEqual([]);
		const [saved] = await db.select().from(schema.orders);
		expect(saved.storeId).toBe(shopify.id);
	});

	test("reports a relayed line TikTok doesn't have", async () => {
		const problems = await takeOver(
			db,
			tiktok.id,
			direct({
				lines: [{ ...direct().lines[0], sku: "BLADE", listingExternalId: "9" }],
			}),
		);
		expect(problems).toEqual(["#5546: Wrench isn't on the TikTok order"]);
	});
});
