import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { applyStoreSales } from "#/orders/remap";
import { receiveReturn } from "#/orders/returns";
import { createProduct, createTestDb } from "#/test/db";
import { postMovements, transferStock, undoBatch } from "./ledger";

let db: Db;
let warehouse: number;
let fba: number;
let storeId: number;
const stockFrom = new Date("2026-10-01T00:00:00Z");
const store = () => ({ id: storeId, stockFrom });

async function addRetail() {
	const [{ id }] = await db
		.insert(schema.locations)
		.values({ name: "Store", kind: "retail" })
		.returning();
	return id;
}

async function onHand(productId: number, locationId: number) {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(
			and(
				eq(schema.stockLevels.productId, productId),
				eq(schema.stockLevels.locationId, locationId),
			),
		);
	return row?.onHand ?? 0;
}

async function stock(productId: number, locationId: number, qty: number) {
	await postMovements(db, {
		lines: [{ productId, locationId, delta: qty, reason: "opening_balance" }],
	});
}

function posOrder(extra: Partial<ChannelOrder> = {}): ChannelOrder {
	return {
		externalId: "gid://shopify/Order/1",
		name: "#1001",
		salesChannel: "Point of Sale",
		marketplaceOrderId: null,
		placedAt: new Date("2026-10-05T12:00:00Z"),
		cancelledAt: null,
		fulfillmentStatus: "FULFILLED",
		fulfilledByChannel: false,
		soldInStore: true,
		financialStatus: "PAID",
		customerName: null,
		shipCity: null,
		shipRegion: null,
		shipCountry: null,
		shipAddress1: null,
		shipAddress2: null,
		shipPostalCode: null,
		shipPhone: null,
		total: 40,
		shippingCharged: 0,
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

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }, { id: fba }] = await db
		.insert(schema.locations)
		.values([
			{ name: "Warehouse", kind: "owned" },
			{ name: "Amazon FBA", kind: "fba" },
		])
		.returning();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify", stockFrom })
		.returning();
});

describe("in-store sales", () => {
	test("take stock off the retail store's shelf, not the warehouse's", async () => {
		const retail = await addRetail();
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);
		await stock(wrench, retail, 5);

		await ingestOrder(db, store(), posOrder(), await stockLocations(db));

		expect(await onHand(wrench, warehouse)).toBe(10);
		expect(await onHand(wrench, retail)).toBe(3);
	});

	test("shipped orders still take from the warehouse", async () => {
		const retail = await addRetail();
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);

		await ingestOrder(
			db,
			store(),
			posOrder({ soldInStore: false, salesChannel: "Online Store" }),
			await stockLocations(db),
		);

		expect(await onHand(wrench, warehouse)).toBe(8);
		expect(await onHand(wrench, retail)).toBe(0);
	});

	test("without a retail store, report it and take nothing", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);

		const { problems } = await ingestOrder(
			db,
			store(),
			posOrder(),
			await stockLocations(db),
		);

		expect(problems).toEqual([
			"#1001: no retail store to take in-store stock from",
		]);
		expect(await onHand(wrench, warehouse)).toBe(10);
	});

	test("take their stock once the retail store is added", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await ingestOrder(db, store(), posOrder(), await stockLocations(db));
		const retail = await addRetail();

		expect(await applyStoreSales(db)).toEqual({ lines: 1, problems: [] });
		expect(await applyStoreSales(db)).toEqual({ lines: 0, problems: [] });
		expect(await onHand(wrench, retail)).toBe(-2);
		expect(await onHand(wrench, warehouse)).toBe(0);
	});

	test("restock where they sold from", async () => {
		const retail = await addRetail();
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, retail, 5);
		const { orderId } = await ingestOrder(
			db,
			store(),
			posOrder(),
			await stockLocations(db),
		);
		const [line] = await db
			.select()
			.from(schema.orderLines)
			.where(eq(schema.orderLines.orderId, orderId));

		await receiveReturn(db, {
			orderId,
			lines: [{ lineId: line.id, quantity: 1 }],
			restock: true,
		});

		expect(await onHand(wrench, retail)).toBe(4);
		expect(await onHand(wrench, warehouse)).toBe(0);
	});
});

describe("transferStock", () => {
	test("moves stock in one batch that undo moves back", async () => {
		const retail = await addRetail();
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 10);

		const { batchId } = await transferStock(db, {
			productId: wrench,
			fromLocationId: warehouse,
			toLocationId: retail,
			quantity: 4,
		});
		expect(await onHand(wrench, warehouse)).toBe(6);
		expect(await onHand(wrench, retail)).toBe(4);

		await undoBatch(db, batchId);
		expect(await onHand(wrench, warehouse)).toBe(10);
		expect(await onHand(wrench, retail)).toBe(0);
	});

	test("refuses more than the shelf holds, changing nothing", async () => {
		const retail = await addRetail();
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 3);

		await expect(
			transferStock(db, {
				productId: wrench,
				fromLocationId: warehouse,
				toLocationId: retail,
				quantity: 4,
			}),
		).rejects.toThrow("Warehouse has 3 of WRENCH, not 4");
		expect(await onHand(wrench, warehouse)).toBe(3);
		expect(await onHand(wrench, retail)).toBe(0);
	});

	test("only between our own locations", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, warehouse, 3);

		await expect(
			transferStock(db, {
				productId: wrench,
				fromLocationId: warehouse,
				toLocationId: fba,
				quantity: 1,
			}),
		).rejects.toThrow("only between our own locations");
		await expect(
			transferStock(db, {
				productId: wrench,
				fromLocationId: warehouse,
				toLocationId: warehouse,
				quantity: 1,
			}),
		).rejects.toThrow("two different locations");
	});
});
