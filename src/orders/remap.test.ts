import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import { mapListing, syncListings } from "#/channels/listings";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { createProduct, createTestDb } from "#/test/db";
import { type ChannelOrder, ingestOrder } from "./ingest";
import { applyListingsToOrders } from "./remap";

let db: Db;
let warehouse: number;
let store: { id: number; stockFrom: Date };

const order = (extra: Partial<ChannelOrder> = {}): ChannelOrder => ({
	externalId: "o1",
	name: "#1001",
	salesChannel: "Online Store",
	marketplaceOrderId: null,
	placedAt: new Date("2026-10-05T00:00:00Z"),
	cancelledAt: null,
	fulfillmentStatus: "UNFULFILLED",
	fulfilledByChannel: false,
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
			listingExternalId: "v1",
			sku: "NEW-SKU",
			title: "New thing",
			quantity: 2,
			unitPrice: 5,
		},
	],
	...extra,
});

async function onHand(productId: number) {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, productId));
	return row?.onHand ?? 0;
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	const [s] = await db
		.insert(schema.stores)
		.values({
			channel: "shopify",
			name: "Shopify",
			stockFrom: new Date("2026-10-01T00:00:00Z"),
		})
		.returning();
	store = { id: s.id, stockFrom: new Date("2026-10-01T00:00:00Z") };
	await syncListings(db, store.id, [
		{
			externalId: "v1",
			externalSku: "NEW-SKU",
			title: "New thing",
			fulfillment: "merchant",
		},
	]);
});

async function listingId() {
	const [l] = await db.select().from(schema.listings);
	return l.id;
}

test("an order for an unmatched listing takes stock once the listing is matched", async () => {
	await ingestOrder(db, store, order(), warehouse);
	const product = await createProduct(db, "THING", "simple");
	await postMovements(db, {
		lines: [
			{
				productId: product,
				locationId: warehouse,
				delta: 5,
				reason: "receipt",
			},
		],
	});

	await mapListing(db, await listingId(), product);
	await applyListingsToOrders(db, [await listingId()], warehouse);
	await applyListingsToOrders(db, [await listingId()], warehouse);

	expect(await onHand(product)).toBe(3);
	const [line] = await db.select().from(schema.orderLines);
	expect(line.productId).toBe(product);
});

test("history-only and FBA orders pick up the product but take no stock", async () => {
	await ingestOrder(
		db,
		store,
		order({ externalId: "old", placedAt: new Date("2026-09-01T00:00:00Z") }),
		warehouse,
	);
	await ingestOrder(
		db,
		store,
		order({ externalId: "fba", fulfilledByChannel: true }),
		warehouse,
	);
	const product = await createProduct(db, "THING", "simple");

	await mapListing(db, await listingId(), product);
	await applyListingsToOrders(db, [await listingId()], warehouse);

	expect(await onHand(product)).toBe(0);
	const lines = await db.select().from(schema.orderLines);
	expect(
		lines.every((l) => l.productId === product && l.saleBatchId === null),
	).toBe(true);
});
