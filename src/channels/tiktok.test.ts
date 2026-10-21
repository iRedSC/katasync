import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { createProduct, createTestDb } from "#/test/db";
import { takeOver, tiktokOrder, tiktokToChannelOrder } from "./tiktok";

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
	soldInStore: false,
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
	tax: { remittedBy: "marketplace" as const, lines: [] },
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
	await ingestOrder(db, shopify, relayed, {
		shipping: warehouse,
		store: null,
		storeKeeps: 0,
	});
	await db
		.update(schema.orders)
		.set({ pin: 49 })
		.where(eq(schema.orders.externalId, relayed.externalId));
});

describe("takeOver", () => {
	test("moves a relayed order to TikTok without taking stock again", async () => {
		expect(await onHand()).toBe(8);
		const order = direct({ fulfillmentStatus: "FULFILLED" });
		expect(await takeOver(db, tiktok.id, order)).toEqual({
			moved: true,
			problems: [],
		});
		await ingestOrder(db, tiktok, order, {
			shipping: warehouse,
			store: null,
			storeKeeps: 0,
		});

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
		await ingestOrder(db, tiktok, direct(), {
			shipping: warehouse,
			store: null,
			storeKeeps: 0,
		});
		await ingestOrder(
			db,
			tiktok,
			direct({ cancelledAt: new Date("2026-10-06T00:00:00Z") }),
			{ shipping: warehouse, store: null, storeKeeps: 0 },
		);
		expect(await onHand()).toBe(10);
	});

	test("does nothing to an order only TikTok has", async () => {
		const other = direct({ marketplaceOrderId: "tiktok:999" });
		expect(await takeOver(db, tiktok.id, other)).toEqual({
			moved: true,
			problems: [],
		});
		const [saved] = await db.select().from(schema.orders);
		expect(saved.storeId).toBe(shopify.id);
	});

	test("keeps an order on Shopify when a line that took stock isn't on TikTok", async () => {
		const result = await takeOver(
			db,
			tiktok.id,
			direct({
				lines: [{ ...direct().lines[0], sku: "BLADE", listingExternalId: "9" }],
			}),
		);
		expect(result).toEqual({
			moved: false,
			problems: [
				"#5546: Wrench isn't on the TikTok order",
				"#5546: left on Shopify until its lines match",
			],
		});
		const [saved] = await db.select().from(schema.orders);
		expect(saved.storeId).toBe(shopify.id);
	});

	test("matches a line by SKU alias when no listing is mapped", async () => {
		await db
			.insert(schema.productAliases)
			.values({ alias: "WRENCH-ALT", productId: wrench });
		// Shopify's line was keyed under a different SKU than TikTok's.
		await db.update(schema.orderLines).set({ sku: "WRENCH-OLD" });
		const order = direct({
			lines: [{ ...direct().lines[0], sku: "WRENCH-ALT" }],
		});
		expect(await takeOver(db, tiktok.id, order)).toEqual({
			moved: true,
			problems: [],
		});
		await ingestOrder(db, tiktok, order, {
			shipping: warehouse,
			store: null,
			storeKeeps: 0,
		});

		expect(await onHand()).toBe(8);
		const lines = await db.select().from(schema.orderLines);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ externalId: "1729", quantity: 2 });
	});
});

// A TikTok detail response, one line item per unit, as the API sends it.
function detail(status: string, units: ("TO_SHIP" | "CANCELLED")[]) {
	return tiktokOrder.assert({
		id: "600",
		status,
		create_time: Math.floor(base.placedAt.getTime() / 1000),
		update_time: Math.floor(base.placedAt.getTime() / 1000) + 60,
		...(status === "CANCELLED" ? { cancel_time: 1791300000 } : {}),
		line_items: units.map((display_status, i) => ({
			id: `unit-${i}`,
			sku_id: "1729",
			seller_sku: "WRENCH",
			product_name: "Wrench",
			sku_name: "Default",
			sale_price: "20.00",
			display_status,
		})),
	});
}

describe("TikTok cancellations through ingestion", () => {
	const sync = (status: string, units: ("TO_SHIP" | "CANCELLED")[]) =>
		ingestOrder(db, tiktok, tiktokToChannelOrder(detail(status, units)), {
			shipping: warehouse,
			store: null,
			storeKeeps: 0,
		});

	test("a cancelled unit gives its stock back", async () => {
		await sync("AWAITING_SHIPMENT", ["TO_SHIP", "TO_SHIP"]);
		expect(await onHand()).toBe(6);
		await sync("AWAITING_SHIPMENT", ["TO_SHIP", "CANCELLED"]);
		expect(await onHand()).toBe(7);
		// Re-syncing the same state changes nothing.
		await sync("AWAITING_SHIPMENT", ["TO_SHIP", "CANCELLED"]);
		expect(await onHand()).toBe(7);
	});

	test("every unit cancelled on a live order gives it all back", async () => {
		await sync("AWAITING_SHIPMENT", ["TO_SHIP", "TO_SHIP"]);
		await sync("AWAITING_SHIPMENT", ["CANCELLED", "CANCELLED"]);
		expect(await onHand()).toBe(8);
		const lines = await db.select().from(schema.orderLines);
		expect(lines.filter((l) => l.externalId === "1729")).toMatchObject([
			{ quantity: 0 },
		]);
	});

	test("a cancelled order gives everything back and keeps its lines", async () => {
		await sync("AWAITING_SHIPMENT", ["TO_SHIP", "TO_SHIP"]);
		await sync("CANCELLED", ["CANCELLED", "CANCELLED"]);
		expect(await onHand()).toBe(8);
		const [line] = await db
			.select()
			.from(schema.orderLines)
			.where(eq(schema.orderLines.externalId, "1729"));
		expect(line).toMatchObject({ quantity: 2 });
	});

	test("a unit cancelled after a first sync that never took stock stays quiet", async () => {
		await sync("AWAITING_SHIPMENT", ["CANCELLED", "CANCELLED"]);
		expect(await onHand()).toBe(8);
	});
});

test("a masked TikTok buyer name is kept, a masked address is not", () => {
	const order = tiktokOrder.assert({
		...detail("AWAITING_SHIPMENT", ["TO_SHIP"]),
		recipient_address: { name: "D*****", address_line1: "1** M*** St" },
	});
	expect(tiktokToChannelOrder(order)).toMatchObject({
		customerName: "D*****",
		shipAddress1: null,
	});
});
