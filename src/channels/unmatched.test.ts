import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { ingestOrder } from "#/orders/ingest";
import { matchListing, productFromListing } from "#/orders/remap";
import { createTestDb } from "#/test/db";
import { syncListings } from "./listings";
import { countUnmatched, listUnmatched } from "./unmatched";

let db: Db;
let shopify: { id: number; stockFrom: Date };
let tiktok: number;
let warehouse: number;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	const stockFrom = new Date("2026-10-01T00:00:00Z");
	const [s] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify", stockFrom })
		.returning();
	shopify = { id: s.id, stockFrom };
	[{ id: tiktok }] = await db
		.insert(schema.stores)
		.values({ channel: "tiktok", name: "TikTok", stockFrom })
		.returning();
	await syncListings(db, shopify.id, [
		{
			externalId: "v1",
			externalSku: null,
			title: "Rock Splicer",
			fulfillment: "merchant",
		},
		{
			externalId: "v2",
			externalSku: "SK4",
			title: "Rebuild Kit",
			fulfillment: "merchant",
		},
		{
			externalId: "v3",
			externalSku: "SK5",
			title: "Rebuild Kit",
			fulfillment: "merchant",
		},
	]);
	await syncListings(db, tiktok, [
		{
			externalId: "t1",
			externalSku: null,
			title: "rock splicer",
			fulfillment: "merchant",
		},
	]);
});

const sell = (listingExternalId: string | null, sku: string | null) =>
	ingestOrder(
		db,
		shopify,
		{
			externalId: `o-${listingExternalId ?? sku}`,
			name: "#1",
			salesChannel: "Online Store",
			marketplaceOrderId: null,
			placedAt: new Date("2026-10-05T00:00:00Z"),
			cancelledAt: null,
			fulfillmentStatus: "UNFULFILLED",
			fulfilledByChannel: false,
			soldInStore: false,
			financialStatus: "PAID",
			customerName: null,
			shipCity: null,
			shipRegion: null,
			shipCountry: null,
			shipAddress1: null,
			shipAddress2: null,
			shipPostalCode: null,
			shipPhone: null,
			total: 10,
			shippingCharged: 0,
			sourceUpdatedAt: new Date("2026-10-05T00:00:00Z"),
			lines: [
				{
					externalId: "l1",
					listingExternalId,
					sku,
					title: "Rock Splicer",
					quantity: 3,
					unitPrice: 5,
				},
			],
		},
		{ shipping: warehouse, store: null, storeKeeps: 0 },
	);

test("the same item on two channels is one item; different SKUs stay apart", async () => {
	await sell("v1", null);
	const items = await listUnmatched(db);
	expect(
		items.map((i) => [i.title, i.sku, i.listingIds.length, i.units]),
	).toEqual([
		["Rock Splicer", null, 2, 3],
		["Rebuild Kit", "SK4", 1, 0],
		["Rebuild Kit", "SK5", 1, 0],
	]);
	expect(await countUnmatched(db)).toBe(3);
});

test("custom items typed into an order are never in the queue", async () => {
	await sell(null, "CUSTOM-1");
	expect((await listUnmatched(db)).every((i) => i.units === 0)).toBe(true);
});

test("an order shows only the items it sold", async () => {
	const o = await sell("v1", null);
	const items = await listUnmatched(db, { orderId: o.orderId });
	expect(items.map((i) => i.title)).toEqual(["Rock Splicer"]);
});

test("matching an item matches all its listings and catches up its orders", async () => {
	await sell("v1", null);
	await db
		.insert(schema.products)
		.values({ sku: "ROCK-SPL", name: "Rock Splicer", kind: "simple" });
	const [item] = await listUnmatched(db);
	expect(item.candidates[0]).toMatchObject({ sku: "ROCK-SPL" });

	const r = await matchListing(db, item.listingIds, "ROCK-SPL");
	expect(r.ordersUpdated).toBe(1);
	expect((await listUnmatched(db)).map((i) => i.sku)).toEqual(["SK4", "SK5"]);
	// A screen still showing it can't match it again.
	await expect(matchListing(db, item.listingIds, "ROCK-SPL")).rejects.toThrow(
		"Already matched",
	);
});

test("a listing with no SKU needs one to become a product", async () => {
	const item = (await listUnmatched(db)).find((i) => i.sku === null);
	if (!item) throw new Error("No item without a SKU");
	await expect(productFromListing(db, item.listingIds)).rejects.toThrow(
		"give the product one",
	);
	const r = await productFromListing(db, item.listingIds, { sku: "RS-1" });
	expect(r.sku).toBe("RS-1");
	expect(await countUnmatched(db)).toBe(2);
});

test("a listing tagged intangible never waits for a product, and costs nothing", async () => {
	await syncListings(db, shopify.id, [
		{
			externalId: "v1",
			externalSku: null,
			title: "Rock Splicer",
			fulfillment: "merchant",
			tags: ["Intangible"],
		},
	]);
	const o = await sell("v1", null);
	// Its untagged TikTok copy still waits.
	expect((await listUnmatched(db)).map((i) => i.listingIds.length)).toEqual([
		1, 1, 1,
	]);
	const [line] = await db
		.select()
		.from(schema.orderLineProfit)
		.where(eq(schema.orderLineProfit.orderId, o.orderId));
	expect(line).toMatchObject({ cost: 0, costKnown: true });
});

test("a draft or deleted listing waits for a product only if it ever sold", async () => {
	await syncListings(db, shopify.id, [
		{
			externalId: "v1",
			externalSku: null,
			title: "Rock Splicer",
			fulfillment: "merchant",
			status: "ARCHIVED",
		},
		{
			externalId: "v2",
			externalSku: "SK4",
			title: "Rebuild Kit",
			fulfillment: "merchant",
			status: "DELETED",
		},
		{
			externalId: "v3",
			externalSku: "SK5",
			title: "Rebuild Kit",
			fulfillment: "merchant",
			status: "DRAFT",
		},
	]);
	await sell("v1", null);
	expect((await listUnmatched(db)).map((i) => [i.sku, i.units])).toEqual([
		[null, 3],
	]);
});
