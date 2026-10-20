import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import { mapListing, syncListings } from "#/channels/listings";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { createProduct, createTestDb } from "#/test/db";
import { type ChannelOrder, ingestOrder } from "./ingest";
import { applyListingsToOrders, applySkusToOrders, linkSku } from "./remap";

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
	await ingestOrder(db, store, order(), { shipping: warehouse, store: null });
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
	await applyListingsToOrders(db, [await listingId()], {
		shipping: warehouse,
		store: null,
	});
	await applyListingsToOrders(db, [await listingId()], {
		shipping: warehouse,
		store: null,
	});

	expect(await onHand(product)).toBe(3);
	const [line] = await db.select().from(schema.orderLines);
	expect(line.productId).toBe(product);
});

test("history-only and FBA orders pick up the product but take no stock", async () => {
	await ingestOrder(
		db,
		store,
		order({ externalId: "old", placedAt: new Date("2026-09-01T00:00:00Z") }),
		{ shipping: warehouse, store: null },
	);
	await ingestOrder(
		db,
		store,
		order({ externalId: "fba", fulfilledByChannel: true }),
		{ shipping: warehouse, store: null },
	);
	const product = await createProduct(db, "THING", "simple");

	await mapListing(db, await listingId(), product);
	await applyListingsToOrders(db, [await listingId()], {
		shipping: warehouse,
		store: null,
	});

	expect(await onHand(product)).toBe(0);
	const lines = await db.select().from(schema.orderLines);
	expect(
		lines.every((l) => l.productId === product && l.saleBatchId === null),
	).toBe(true);
});

// A line sold with no listing to match, as eBay's are while its listings
// don't sync.
const unlisted = (sku: string, externalId = "o1") =>
	order({
		externalId,
		lines: [
			{
				externalId: "l1",
				listingExternalId: null,
				sku,
				title: "Sander",
				quantity: 1,
				unitPrice: 5,
			},
		],
	});

async function stocked(sku: string, quantity: number) {
	const product = await createProduct(db, sku, "simple");
	await postMovements(db, {
		lines: [
			{
				productId: product,
				locationId: warehouse,
				delta: quantity,
				reason: "receipt",
			},
		],
	});
	return product;
}

test("a SKU in other capitals finds its product", async () => {
	const product = await stocked("FCI-RAD360", 3);
	await ingestOrder(db, store, unlisted("FCI-Rad360"), {
		shipping: warehouse,
		store: null,
	});

	const [line] = await db.select().from(schema.orderLines);
	expect(line.productId).toBe(product);
	expect(await onHand(product)).toBe(2);
});

test("a SKU in other capitals is left for a person when two products have it", async () => {
	await stocked("ab-1", 3);
	await stocked("AB-1", 3);
	await ingestOrder(db, store, unlisted("Ab-1"), {
		shipping: warehouse,
		store: null,
	});

	const [line] = await db.select().from(schema.orderLines);
	expect(line.productId).toBeNull();
});

test("lines synced before their product existed catch up once, by channel", async () => {
	await ingestOrder(db, store, unlisted("LATER"), {
		shipping: warehouse,
		store: null,
	});
	const product = await stocked("LATER", 3);

	await applySkusToOrders(
		db,
		{ channel: "ebay" },
		{ shipping: warehouse, store: null },
	);
	expect(await onHand(product)).toBe(3);

	await applySkusToOrders(
		db,
		{ channel: "shopify" },
		{ shipping: warehouse, store: null },
	);
	await applySkusToOrders(
		db,
		{ channel: "shopify" },
		{ shipping: warehouse, store: null },
	);
	expect(await onHand(product)).toBe(2);
});

test("linking a SKU catches up its orders and later ones", async () => {
	const product = await stocked("SANDER", 5);
	await ingestOrder(db, store, unlisted("FCI-SAND"), {
		shipping: warehouse,
		store: null,
	});

	const linked = await linkSku(db, "FCI-SAND", "SANDER");
	expect(linked).toEqual({ sku: "SANDER", ordersUpdated: 1, problems: [] });
	expect(await onHand(product)).toBe(4);

	await ingestOrder(db, store, unlisted("FCI-SAND", "o2"), {
		shipping: warehouse,
		store: null,
	});
	expect(await onHand(product)).toBe(3);

	// Linking again changes nothing.
	await linkSku(db, "FCI-SAND", "SANDER");
	expect(await onHand(product)).toBe(3);
});

test("linking maps listings with that SKU", async () => {
	const product = await createProduct(db, "THING", "simple");
	await linkSku(db, "NEW-SKU", "THING");

	const [listing] = await db.select().from(schema.listings);
	expect(listing.productId).toBe(product);
});

test("a SKU can't be linked over another product's", async () => {
	await createProduct(db, "ONE", "simple");
	await createProduct(db, "TWO", "simple");
	await linkSku(db, "X-1", "ONE");

	await expect(linkSku(db, "X-1", "TWO")).rejects.toThrow(
		"X-1 is already linked to ONE",
	);
	await expect(linkSku(db, "ONE", "TWO")).rejects.toThrow(
		"ONE is already the SKU of its own product",
	);
});
