import { eq } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import { mapListing, syncListings } from "#/channels/listings";
import type { StockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { diagnosticsOverview } from "#/diagnostics/overview";
import { recordSyncRun } from "#/diagnostics/runs";
import { postMovements } from "#/inventory/ledger";
import { createProduct, createTestDb } from "#/test/db";
import { type ChannelOrder, ingestOrder } from "./ingest";
import { reconcileStock } from "./reconcile-stock";
import { applyListingsToOrders, applySkusToOrders } from "./remap";

let db: Db;
let store: { id: number; stockFrom: Date };
let product: number;
let listingId: number;
let ours: StockLocations;
let none: StockLocations;

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
	tax: { remittedBy: "seller", lines: [] },
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

const NO_LOCATION = "#1001: no location to take stock from";

async function onHand() {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, product));
	return row?.onHand ?? 0;
}

async function lines() {
	return db.select().from(schema.orderLines);
}

async function saleCount() {
	return (
		await db
			.select()
			.from(schema.movements)
			.where(eq(schema.movements.reason, "sale"))
	).length;
}

async function shopifyIssues() {
	const overview = await diagnosticsOverview(db);
	return overview.channels.find((c) => c.channel === "shopify");
}

beforeEach(async () => {
	vi.stubEnv("SHOPIFY_STORE_DOMAIN", "test.myshopify.com");
	vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "token");
	db = await createTestDb();
	const [warehouse] = await db
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
	ours = { shipping: warehouse.id, store: null, pos: null, storeKeeps: 0 };
	none = { ...ours, shipping: null };
	await syncListings(db, store.id, [
		{
			externalId: "v1",
			externalSku: "NEW-SKU",
			title: "New thing",
			fulfillment: "merchant",
		},
	]);
	[{ id: listingId }] = await db.select().from(schema.listings);
	product = await createProduct(db, "THING", "simple");
	await mapListing(db, listingId, product);
	await postMovements(db, {
		lines: [
			{
				productId: product,
				locationId: warehouse.id,
				delta: 5,
				reason: "receipt",
			},
		],
	});
});

test("a line that couldn't take stock keeps its product, and the next sync takes it once it can", async () => {
	const saved = await ingestOrder(db, store, order(), none);
	expect(saved.problems).toEqual([NO_LOCATION]);
	const [failed] = await lines();
	expect(failed.productId).toBe(product);
	expect(failed.saleBatchId).toBeNull();

	const stillFailing = await applySkusToOrders(
		db,
		{ channel: "shopify" },
		none,
	);
	expect(stillFailing.problems).toEqual([NO_LOCATION]);
	expect(await onHand()).toBe(5);

	const repaired = await applySkusToOrders(db, { channel: "shopify" }, ours);
	expect(repaired.problems).toEqual([]);
	expect(await onHand()).toBe(3);
	expect((await lines())[0].saleBatchId).not.toBeNull();

	const retried = await applySkusToOrders(db, { channel: "shopify" }, ours);
	expect(retried.problems).toEqual([]);
	expect(await onHand()).toBe(3);
	expect(await saleCount()).toBe(1);
});

test("a stuck line is taken when its listing is next caught up", async () => {
	await ingestOrder(db, store, order(), none);

	const caught = await applyListingsToOrders(db, [listingId], ours);
	expect(caught.problems).toEqual([]);
	expect(await onHand()).toBe(3);

	await applyListingsToOrders(db, [listingId], ours);
	expect(await onHand()).toBe(3);
	expect(await saleCount()).toBe(1);
});

test("reconciling a stuck line is idempotent when it still fails", async () => {
	await ingestOrder(db, store, order(), none);

	expect(await reconcileStock(db, none)).toEqual({
		lines: 0,
		problems: [NO_LOCATION],
	});
	expect(await reconcileStock(db, none)).toEqual({
		lines: 0,
		problems: [NO_LOCATION],
	});
	expect(await onHand()).toBe(5);
	expect(await saleCount()).toBe(0);
});

test("Diagnostics keeps showing stock not taken after a newer sync run is clean", async () => {
	await ingestOrder(db, store, order(), none);
	await recordSyncRun(db, "shopify", async () => ({
		orders: 1,
		problems: [] as string[],
	}));

	const before = await shopifyIssues();
	expect(before?.issues).toEqual([
		expect.objectContaining({
			message: "Stock not taken for THING",
			count: 1,
			references: ["#1001"],
			dismissed: false,
		}),
	]);
	expect(before?.health).toBe("degraded");

	await applySkusToOrders(db, { channel: "shopify" }, ours);
	const after = await shopifyIssues();
	expect(after?.issues).toEqual([]);
	expect(after?.health).toBe("healthy");
});

test.each<[string, Partial<ChannelOrder>]>([
	["cancelled", { cancelledAt: new Date("2026-10-06T00:00:00Z") }],
	["fulfilled by the marketplace", { fulfilledByChannel: true }],
	[
		"placed before the stock date",
		{ placedAt: new Date("2026-09-01T00:00:00Z") },
	],
])("%s orders are never owed stock", async (_, extra) => {
	await ingestOrder(db, store, order(extra), ours);
	const [line] = await lines();
	expect(line.productId).toBe(product);
	expect(line.saleBatchId).toBeNull();

	expect(await reconcileStock(db, ours)).toEqual({ lines: 0, problems: [] });
	expect(await onHand()).toBe(5);
	expect(await saleCount()).toBe(0);

	const issues = await shopifyIssues();
	expect(issues?.issues).toEqual([]);
	expect(issues?.health).toBe("never_synced");
});
