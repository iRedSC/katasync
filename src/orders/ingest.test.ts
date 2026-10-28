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
		fulfilledByChannel: false,
		soldInStore: false,
		financialStatus: "PAID",
		customerName: "Pat Doe",
		buyerId: null,
		shipCity: "Harrisburg",
		shipRegion: "PA",
		shipCountry: "US",
		shipAddress1: "1 Main St",
		shipAddress2: null,
		shipPostalCode: "17101",
		shipPhone: null,
		total: 50,
		shippingCharged: 10,
		tax: { remittedBy: "seller", lines: [] },
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

		await ingestOrder(db, store(), order(), {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});
		await ingestOrder(db, store(), order({ fulfillmentStatus: "FULFILLED" }), {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});

		expect(await onHand(wrench)).toBe(8);
		const lines = await db.select().from(schema.orderLines);
		expect(lines).toHaveLength(1);
		expect(lines[0].saleBatchId).not.toBeNull();
	});

	test("goes by the store's stockFrom as it is now, not as the caller read it", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		// A cutover moved the date after the sync pass read its store.
		await db
			.update(schema.stores)
			.set({ stockFrom: new Date("2026-10-10T00:00:00Z") })
			.where(eq(schema.stores.id, storeId));
		await ingestOrder(db, store(), order(), {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});
		expect(await onHand(wrench)).toBe(10);
	});

	test("orders from before stockFrom are history only", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		await ingestOrder(
			db,
			store(),
			order({ placedAt: new Date("2026-09-20T00:00:00Z") }),
			{ shipping: warehouse, store: null, pos: null, storeKeeps: 0 },
		);
		expect(await onHand(wrench)).toBe(10);
		expect(await db.select().from(schema.orders)).toHaveLength(1);
	});

	test("a cancellation gives back exactly what the order took", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		await ingestOrder(db, store(), order(), {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});
		const cancelled = order({ cancelledAt: new Date("2026-10-06T00:00:00Z") });
		await ingestOrder(db, store(), cancelled, {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});
		await ingestOrder(db, store(), cancelled, {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});
		expect(await onHand(wrench)).toBe(10);
	});

	test("units cancelled from a line give back just their stock", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		await ingestOrder(db, store(), order(), {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});
		const [line] = order().lines;
		for (const quantity of [1, 0]) {
			await ingestOrder(
				db,
				store(),
				order({ lines: [{ ...line, quantity }] }),
				{ shipping: warehouse, store: null, pos: null, storeKeeps: 0 },
			);
			expect(await onHand(wrench)).toBe(10 - quantity);
		}
	});

	test("a line already cancelled when first seen isn't saved", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		const [line] = order().lines;
		const { orderId } = await ingestOrder(
			db,
			store(),
			order({ lines: [{ ...line, quantity: 0 }] }),
			{ shipping: warehouse, store: null, pos: null, storeKeeps: 0 },
		);
		const saved = await db
			.select()
			.from(schema.orderLines)
			.where(eq(schema.orderLines.orderId, orderId));
		expect(saved).toEqual([]);
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
		await ingestOrder(db, store(), order({ lines: [line] }), {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});

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
		const { problems } = await ingestOrder(db, store(), order({ lines }), {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});

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
		await ingestOrder(db, store(), order({ lines: [line] }), {
			shipping: warehouse,
			store: null,
			pos: null,
			storeKeeps: 0,
		});
		expect(await onHand(kit)).toBe(2);
	});

	test("a custom item with no SKU is saved without a flag", async () => {
		const line = { ...order().lines[0], sku: null, title: "Custom sharpening" };
		const { problems } = await ingestOrder(
			db,
			store(),
			order({ lines: [line] }),
			{ shipping: warehouse, store: null, pos: null, storeKeeps: 0 },
		);
		expect(problems).toEqual([]);
		expect(await db.select().from(schema.orderLines)).toHaveLength(1);
	});

	test("the same marketplace order can't be saved twice from two sources", async () => {
		await ingestOrder(
			db,
			store(),
			order({ marketplaceOrderId: "tiktok:577609" }),
			{ shipping: warehouse, store: null, pos: null, storeKeeps: 0 },
		);
		const otherSource = order({
			externalId: "tiktok-direct-577609",
			marketplaceOrderId: "tiktok:577609",
		});
		await expect(
			ingestOrder(db, store(), otherSource, {
				shipping: warehouse,
				store: null,
				pos: null,
				storeKeeps: 0,
			}),
		).rejects.toThrow();
		expect(await db.select().from(schema.orders)).toHaveLength(1);
	});

	test("an order shipped by the marketplace (FBA) never takes our stock", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		const { problems } = await ingestOrder(
			db,
			store(),
			order({
				fulfilledByChannel: true,
				fulfillmentStatus: "FULFILLMENT_NOT_REQUIRED",
			}),
			{ shipping: warehouse, store: null, pos: null, storeKeeps: 0 },
		);
		expect(problems).toEqual([]);
		expect(await onHand(wrench)).toBe(10);
	});

	test("an older snapshot after a newer cancellation changes nothing", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await stock(wrench, 10);
		const from = { shipping: warehouse, store: null, pos: null, storeKeeps: 0 };
		const live = order();
		await ingestOrder(db, store(), live, from);
		await ingestOrder(
			db,
			store(),
			order({
				cancelledAt: new Date("2026-10-06T00:00:00Z"),
				sourceUpdatedAt: new Date("2026-10-06T00:00:00Z"),
				lines: [{ ...live.lines[0], quantity: 0 }],
			}),
			from,
		);
		// The live snapshot arrives late, read before the cancellation.
		await ingestOrder(db, store(), order({ total: 99 }), from);

		const [saved] = await db.select().from(schema.orders);
		expect(saved.cancelledAt).not.toBeNull();
		expect(saved.total).toBe(50);
		const [line] = await db.select().from(schema.orderLines);
		expect(line.quantity).toBe(0);
		expect(await onHand(wrench)).toBe(10);
	});

	test("a line whose product appears later picks up its cost with it", async () => {
		const from = { shipping: warehouse, store: null, pos: null, storeKeeps: 0 };
		await ingestOrder(db, store(), order(), from);
		const wrench = await createProduct(db, "WRENCH", "simple");
		await db
			.update(schema.products)
			.set({ unitCost: 7.5 })
			.where(eq(schema.products.id, wrench));
		// The same version again: what's new is the product, not the order.
		await ingestOrder(db, store(), order(), from);
		const [line] = await db.select().from(schema.orderLines);
		expect(line).toMatchObject({ productId: wrench, unitCost: 7.5 });

		// A mapped line keeps the cost it sold at.
		await db
			.update(schema.products)
			.set({ unitCost: 9 })
			.where(eq(schema.products.id, wrench));
		await ingestOrder(
			db,
			store(),
			order({ lines: [{ ...order().lines[0], quantity: 3 }] }),
			from,
		);
		const [resized] = await db.select().from(schema.orderLines);
		expect(resized.unitCost).toBe(7.5);
	});
});
