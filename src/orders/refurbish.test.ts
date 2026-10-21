import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as shopify from "#/channels/shopify/refurbish";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements, recordSale } from "#/inventory/ledger";
import { createProduct, createTestDb } from "#/test/db";
import { retireRefurbs } from "./refurb-retire";
import { refurbishOptions, refurbishReturn } from "./refurbish";
import { receiveReturn, undoReturns } from "./returns";

vi.mock("#/channels/shopify/refurbish", () => ({
	shopifyConditions: vi.fn(async () => [
		{
			id: "gid://shopify/Metaobject/1",
			handle: "excellent",
			label: "Excellent",
			description: null,
			color: "#1ea15b",
		},
	]),
	shopifyOriginal: vi.fn(async () => null),
	createRefurbDraft: vi.fn(async (input: { sku: string }) => ({
		productId: `gid://shopify/Product/${input.sku}`,
		variantId: `gid://shopify/ProductVariant/${input.sku}`,
	})),
	deleteShopifyVariant: vi.fn(async () => {}),
	archiveShopifyVariant: vi.fn(async () => {}),
}));

let db: Db;
let warehouse: number;
let wrench: number;

async function onHand(productId: number) {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, productId));
	return row?.onHand ?? 0;
}

// A shipped order selling 2 wrenches at $20, which cost $8 when they sold.
async function shippedOrder() {
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: `Store ${Math.random()}` })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: `gid://shopify/Order/${Math.random()}`,
			name: "#1001",
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 40,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	const [line] = await db
		.insert(schema.orderLines)
		.values({
			orderId: order.id,
			externalId: "line-1",
			productId: wrench,
			sku: "WRENCH",
			title: "Wrench",
			quantity: 2,
			unitPrice: 20,
			unitCost: 8,
		})
		.returning();
	const { batchId } = await recordSale(db, {
		productId: wrench,
		quantity: 2,
		locationId: warehouse,
		reference: `sale:${line.id}`,
	});
	await postMovements(db, {
		lines: [
			{
				productId: wrench,
				locationId: warehouse,
				delta: 2,
				reason: "opening_balance",
			},
		],
	});
	await db
		.update(schema.orderLines)
		.set({ saleBatchId: batchId })
		.where(eq(schema.orderLines.id, line.id));
	return { orderId: order.id, lineId: line.id };
}

const refurbish = (o: { orderId: number; lineId: number }, quantity = 1) =>
	refurbishReturn(db, {
		...o,
		quantity,
		condition: "excellent",
		title: "Wrench",
		price: 15,
	});

beforeEach(async () => {
	vi.clearAllMocks();
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	wrench = await createProduct(db, "WRENCH", "simple");
	await db
		.update(schema.products)
		.set({ unitCost: 9, weightGrams: 500 })
		.where(eq(schema.products.id, wrench));
});

describe("refurbishReturn", () => {
	test("drafts it in Shopify and puts the unit on its shelf, at what it cost", async () => {
		const o = await shippedOrder();
		const made = await refurbish(o);
		expect(made.sku).toBe("WRENCH-R1");
		expect(shopify.createRefurbDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				sku: "WRENCH-R1",
				handle: "wrench-refurbished-1",
				conditionId: "gid://shopify/Metaobject/1",
				quantity: 1,
				unitCost: 8,
			}),
		);
		const [refurb] = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, made.productId));
		expect(refurb).toMatchObject({
			refurbishedFromId: wrench,
			condition: "excellent",
			unitCost: 8,
			weightGrams: 500,
		});
		const [listing] = await db
			.select()
			.from(schema.listings)
			.where(eq(schema.listings.productId, made.productId));
		expect(listing).toMatchObject({
			externalId: "gid://shopify/ProductVariant/WRENCH-R1",
			status: "DRAFT",
		});
		expect(await onHand(made.productId)).toBe(1);
		// The wrench itself didn't come back.
		expect(await onHand(wrench)).toBe(0);
		// The order isn't charged for the unit its refurb carries.
		const [cost] = await db
			.select()
			.from(schema.orderLineProfit)
			.where(eq(schema.orderLineProfit.lineId, o.lineId));
		expect(cost).toMatchObject({ restocked: 1, cost: 8 });
	});

	test("the next refurb takes the next SKU, and more can join an existing one", async () => {
		const o = await shippedOrder();
		const first = await refurbish(o);
		const options = await refurbishOptions(db, o);
		expect(options).toMatchObject({
			sku: "WRENCH-R2",
			existing: [{ sku: "WRENCH-R1", condition: "excellent", onHand: 1 }],
		});
		await receiveReturn(db, {
			orderId: o.orderId,
			lines: [{ lineId: o.lineId, quantity: 1 }],
			outcome: { refurbishInto: first.productId },
		});
		expect(await onHand(first.productId)).toBe(2);
	});

	test("a refusal after the draft deletes it again and leaves nothing", async () => {
		const o = await shippedOrder();
		await expect(refurbish(o, 3)).rejects.toThrow("Only 2");
		expect(shopify.deleteShopifyVariant).toHaveBeenCalledWith(
			"gid://shopify/ProductVariant/WRENCH-R1",
		);
		const refurbs = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.sku, "WRENCH-R1"));
		expect(refurbs).toEqual([]);
	});

	test("only a refurb of what the line sold can take its units", async () => {
		const o = await shippedOrder();
		const other = await createProduct(db, "HAWK", "simple");
		await expect(
			receiveReturn(db, {
				orderId: o.orderId,
				lines: [{ lineId: o.lineId, quantity: 1 }],
				outcome: { refurbishInto: other },
			}),
		).rejects.toThrow("isn't made from");
	});
});

describe("retiring refurbs", () => {
	test("undoing its return deletes the draft and archives it", async () => {
		const o = await shippedOrder();
		const made = await refurbish(o);
		expect(await undoReturns(db, made.ids)).toEqual({ problems: [] });
		expect(await onHand(made.productId)).toBe(0);
		expect(shopify.deleteShopifyVariant).toHaveBeenCalledWith(
			"gid://shopify/ProductVariant/WRENCH-R1",
		);
		const [refurb] = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, made.productId));
		expect(refurb.archivedAt).not.toBeNull();
	});

	test("once it sells, its return can't come off, and the sweep archives it", async () => {
		const o = await shippedOrder();
		const made = await refurbish(o);
		await recordSale(db, {
			productId: made.productId,
			quantity: 1,
			locationId: warehouse,
			reference: "sale:refurb",
		});
		await expect(undoReturns(db, made.ids)).rejects.toThrow("has sold since");

		expect(await retireRefurbs(db)).toEqual({ problems: [] });
		expect(shopify.archiveShopifyVariant).toHaveBeenCalledWith(
			"gid://shopify/ProductVariant/WRENCH-R1",
		);
		expect(shopify.deleteShopifyVariant).not.toHaveBeenCalled();
		const [refurb] = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, made.productId));
		expect(refurb.archivedAt).not.toBeNull();
	});

	test("one with stock left stays", async () => {
		const o = await shippedOrder();
		const made = await refurbish(o, 2);
		await recordSale(db, {
			productId: made.productId,
			quantity: 1,
			locationId: warehouse,
			reference: "sale:refurb",
		});
		await retireRefurbs(db);
		expect(shopify.archiveShopifyVariant).not.toHaveBeenCalled();
	});
});
