import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import { type ChannelOrder, ingestOrder } from "./ingest";

let db: Db;
let warehouse: number;
let storeId: number;
const stockFrom = new Date("2026-10-01T00:00:00Z");

function order(extra: Partial<ChannelOrder> = {}): ChannelOrder {
	return {
		externalId: "gid://shopify/Order/1",
		name: "#1001",
		salesChannel: "Online Store",
		marketplaceOrderId: null,
		placedAt: new Date("2026-10-05T12:00:00Z"),
		cancelledAt: null,
		fulfillmentStatus: "UNFULFILLED",
		financialStatus: "PAID",
		customerName: "Pat Doe",
		shipCity: "Harrisburg",
		shipRegion: "PA",
		shipCountry: "US",
		total: 50,
		shippingCharged: 10,
		sourceUpdatedAt: new Date("2026-10-05T12:00:00Z"),
		lines: [
			{
				externalId: "line-1",
				listingExternalId: null,
				sku: "WRENCH",
				title: "Wrench",
				quantity: 2,
				unitPrice: 20,
			},
		],
		...extra,
	};
}

async function onHand(productId: number) {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, productId));
	return row?.onHand ?? 0;
}

async function stock(productId: number, qty: number) {
	await postMovements(db, {
		lines: [
			{
				productId,
				locationId: warehouse,
				delta: qty,
				reason: "opening_balance",
			},
		],
	});
}

const store = () => ({ id: storeId, stockFrom });

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify", stockFrom })
		.returning();
});

describe("ingestOrder", () => {
	test("takes stock once, however many times the order syncs", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);

		await ingestOrder(db, store(), order(), warehouse);
		await ingestOrder(
			db,
			store(),
			order({ fulfillmentStatus: "FULFILLED" }),
			warehouse,
		);

		expect(await onHand(wrench)).toBe(8);
		const lines = await db.select().from(schema.orderLines);
		expect(lines).toHaveLength(1);
		expect(lines[0].saleBatchId).not.toBeNull();
	});

	test("orders from before stockFrom are history only", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		await ingestOrder(
			db,
			store(),
			order({ placedAt: new Date("2026-09-20T00:00:00Z") }),
			warehouse,
		);
		expect(await onHand(wrench)).toBe(10);
		expect(await db.select().from(schema.orders)).toHaveLength(1);
	});

	test("a cancellation gives back exactly what the order took", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		await ingestOrder(db, store(), order(), warehouse);
		const cancelled = order({ cancelledAt: new Date("2026-10-06T00:00:00Z") });
		await ingestOrder(db, store(), cancelled, warehouse);
		await ingestOrder(db, store(), cancelled, warehouse);
		expect(await onHand(wrench)).toBe(10);
	});

	test("a tool set takes its parts and records their combined cost", async () => {
		const handle = await createProduct(db, "HANDLE", "simple");
		const blade = await createProduct(db, "BLADE", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await db
			.update(schema.products)
			.set({ unitCost: 5 })
			.where(eq(schema.products.id, handle));
		await db
			.update(schema.products)
			.set({ unitCost: 2 })
			.where(eq(schema.products.id, blade));
		await setRecipe(db, set, [
			{ productId: handle, quantity: 1 },
			{ productId: blade, quantity: 3 },
		]);
		await stock(handle, 5);
		await stock(blade, 9);

		const line = { ...order().lines[0], sku: "SET", quantity: 1 };
		await ingestOrder(db, store(), order({ lines: [line] }), warehouse);

		expect(await onHand(handle)).toBe(4);
		expect(await onHand(blade)).toBe(6);
		const [saved] = await db.select().from(schema.orderLines);
		expect(saved.unitCost).toBe(11);
	});

	test("an unknown SKU is saved and reported without stopping the order", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		const lines = [
			order().lines[0],
			{
				...order().lines[0],
				externalId: "line-2",
				sku: "MYSTERY",
				title: "Mystery",
			},
		];
		const { problems } = await ingestOrder(
			db,
			store(),
			order({ lines }),
			warehouse,
		);

		expect(problems).toEqual(["#1001: no product for MYSTERY"]);
		expect(await onHand(wrench)).toBe(8);
		expect(await db.select().from(schema.orderLines)).toHaveLength(2);
	});

	test("an Amazon alias SKU resolves to its product", async () => {
		const kit = await createProduct(db, "ECDT-12KIT", "simple");
		await db
			.insert(schema.productAliases)
			.values({ alias: "ECDT-12KIT-AMZ", productId: kit });
		await stock(kit, 3);
		const line = { ...order().lines[0], sku: "ECDT-12KIT-AMZ", quantity: 1 };
		await ingestOrder(db, store(), order({ lines: [line] }), warehouse);
		expect(await onHand(kit)).toBe(2);
	});

	test("a custom item with no SKU is saved without a flag", async () => {
		const line = { ...order().lines[0], sku: null, title: "Custom sharpening" };
		const { problems } = await ingestOrder(
			db,
			store(),
			order({ lines: [line] }),
			warehouse,
		);
		expect(problems).toEqual([]);
		expect(await db.select().from(schema.orderLines)).toHaveLength(1);
	});

	test("the same marketplace order can't be saved twice from two sources", async () => {
		await ingestOrder(
			db,
			store(),
			order({ marketplaceOrderId: "tiktok:577609" }),
			warehouse,
		);
		const otherSource = order({
			externalId: "tiktok-direct-577609",
			marketplaceOrderId: "tiktok:577609",
		});
		await expect(
			ingestOrder(db, store(), otherSource, warehouse),
		).rejects.toThrow();
		expect(await db.select().from(schema.orders)).toHaveLength(1);
	});
});
