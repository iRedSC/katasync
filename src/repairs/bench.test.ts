import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as shopify from "#/channels/shopify/refurbish";
import type { Db } from "#/db/client";
import { repairParts, repairs } from "#/db/repair-schema";
import * as schema from "#/db/schema";
import { postMovements, recordSale } from "#/inventory/ledger";
import { receiveReturn } from "#/orders/returns";
import { createProduct, createTestDb } from "#/test/db";
import { listBench, startBench } from "./bench";
import { moveRepair, setPart } from "./repairs";
import { refuseMove } from "./status";

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
	shopifyTags: vi.fn(async () => []),
	createRefurbDraft: vi.fn(async (_original: unknown, r: { sku: string }) => ({
		productId: `gid://shopify/Product/${r.sku}`,
		variantId: `gid://shopify/ProductVariant/${r.sku}`,
	})),
	shopifySkuTaken: vi.fn(async () => false),
	deleteShopifyVariant: vi.fn(async () => {}),
	archiveShopifyVariant: vi.fn(async () => {}),
}));

let db: Db;
let warehouse: number;
let taper: number;
let blade: number;

const listing = {
	kind: "new" as const,
	condition: "excellent",
	title: "Taper, refurbished",
	price: 900,
	compareAtPrice: null,
	weightGrams: null,
	vendor: "TapeTech",
	productType: "Tapers",
	tags: [],
	notes: "New blade",
};

async function onHand(productId: number) {
	const [row] = await db
		.select({
			n: sql<number>`coalesce(sum(${schema.stockLevels.onHand}), 0)::int`,
		})
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, productId));
	return row.n;
}

// A shipped order of 2 tapers, which cost $500 each when they sold, both
// asked back.
async function returnedOrder() {
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: `Store ${Math.random()}` })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: `gid://shopify/Order/${Math.random()}`,
			name: "#2001",
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 2000,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	const [line] = await db
		.insert(schema.orderLines)
		.values({
			orderId: order.id,
			externalId: "line-1",
			productId: taper,
			sku: "TAPER",
			title: "Taper",
			quantity: 2,
			unitPrice: 1000,
			unitCost: 500,
		})
		.returning();
	await postMovements(db, {
		lines: [
			{
				productId: taper,
				locationId: warehouse,
				delta: 2,
				reason: "opening_balance",
			},
		],
	});
	const { batchId } = await recordSale(db, {
		productId: taper,
		quantity: 2,
		locationId: warehouse,
		reference: `sale:${line.id}`,
	});
	await db
		.update(schema.orderLines)
		.set({ saleBatchId: batchId })
		.where(eq(schema.orderLines.id, line.id));
	const [request] = await db
		.insert(schema.returnRequests)
		.values({
			orderId: order.id,
			billedBy: "shopify",
			externalId: `rr-${Math.random()}`,
			status: "requested",
			waitingOn: "buyer",
			rawStatus: "REQUESTED",
			requestedAt: new Date(),
			sourceUpdatedAt: new Date(),
		})
		.returning();
	await db
		.insert(schema.returnRequestLines)
		.values({ requestId: request.id, orderLineId: line.id, quantity: 2 });
	return { orderId: order.id, lineId: line.id };
}

async function due(lineId: number) {
	const [row] = await db
		.select({ expected: schema.orderReturnsDue.expected })
		.from(schema.orderReturnsDue)
		.where(eq(schema.orderReturnsDue.lineId, lineId));
	return row?.expected ?? 0;
}

const job = async (id: number) =>
	(await db.select().from(repairs).where(eq(repairs.id, id)))[0];

beforeEach(async () => {
	vi.clearAllMocks();
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	taper = await createProduct(db, "TAPER", "simple");
	blade = await createProduct(db, "BLADE", "simple");
	await db
		.update(schema.products)
		.set({ unitCost: 450 })
		.where(eq(schema.products.id, taper));
	await postMovements(db, {
		lines: [
			{ productId: blade, locationId: warehouse, delta: 3, reason: "receipt" },
		],
		costs: [{ productId: blade, kind: "receipt", units: 3, value: 36 }],
	});
});

describe("bench jobs", () => {
	test("a returned unit on the bench is held: not due, and can't be received", async () => {
		const o = await returnedOrder();
		expect(await due(o.lineId)).toBe(2);
		const [id] = await startBench(db, { ...o, quantity: 1 });
		expect(await job(id)).toMatchObject({
			kind: "bench",
			productId: taper,
			returnLineId: o.lineId,
			tool: "TAPER",
			customerId: null,
		});
		expect(await due(o.lineId)).toBe(1);
		await expect(
			receiveReturn(db, {
				...o,
				lines: [{ lineId: o.lineId, quantity: 2 }],
				outcome: "restock",
			}),
		).rejects.toThrow(/Only 1 of TAPER/);
		await expect(startBench(db, { ...o, quantity: 2 })).rejects.toThrow(
			/Only 1 of TAPER/,
		);
	});

	test("listing it makes the refurb from the return, costing the unit plus its parts", async () => {
		const o = await returnedOrder();
		const [id] = await startBench(db, { ...o, quantity: 1 });
		await setPart(db, id, blade, 1);
		const made = await listBench(db, id, listing);
		expect(made.sku).toBe("TAPER-RFB1");
		expect(shopify.createRefurbDraft).toHaveBeenCalledWith(
			null,
			expect.objectContaining({ unitCost: 512, quantity: 1 }),
		);
		const [refurb] = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, made.productId));
		expect(refurb).toMatchObject({ refurbishedFromId: taper, unitCost: 512 });
		expect(await onHand(made.productId)).toBe(1);
		expect(await onHand(blade)).toBe(2);
		const [received] = await db
			.select()
			.from(schema.orderReturns)
			.where(eq(schema.orderReturns.orderLineId, o.lineId));
		expect(received).toMatchObject({
			quantity: 1,
			refurbProductId: made.productId,
		});
		expect(await job(id)).toMatchObject({
			status: "refurbished",
			refurbProductId: made.productId,
		});
		// Still one more due: the other unit.
		expect(await due(o.lineId)).toBe(1);
		await expect(listBench(db, id, listing)).rejects.toThrow(/listed/i);
	});

	test("one bought in comes onto the shelf as the refurb, at the product's cost", async () => {
		await db.insert(schema.stores).values({ channel: "shopify", name: "Shop" });
		const [id] = await startBench(db, { productId: taper, problem: "Leaks" });
		const made = await listBench(db, id, listing);
		expect(await onHand(made.productId)).toBe(1);
		const [refurb] = await db
			.select({ cost: schema.products.unitCost })
			.from(schema.products)
			.where(eq(schema.products.id, made.productId));
		expect(refurb.cost).toBe(450);
	});

	test("another of the same refurb is added to it, checked from its locked row", async () => {
		await db.insert(schema.stores).values({ channel: "shopify", name: "Shop" });
		const [first] = await startBench(db, { productId: taper });
		const [second] = await startBench(db, { productId: taper });
		const [other] = await startBench(db, { productId: blade });
		const made = await listBench(db, first, listing);
		const added = await listBench(db, second, {
			kind: "add",
			productId: made.productId,
		});
		expect(added).toMatchObject({ sku: made.sku, productId: made.productId });
		expect(await onHand(made.productId)).toBe(2);
		await expect(
			listBench(db, other, { kind: "add", productId: made.productId }),
		).rejects.toThrow(/isn't made from BLADE/);
	});

	test("a part not on the shelf stops the listing, leaving nothing made", async () => {
		const [id] = await startBench(db, { productId: taper });
		await setPart(db, id, blade, 5);
		await expect(listBench(db, id, listing)).rejects.toThrow(/Only 3 of BLADE/);
		expect(shopify.createRefurbDraft).not.toHaveBeenCalled();
		expect(await onHand(blade)).toBe(3);
		expect((await job(id)).status).toBe("received");
		const refurbs = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.refurbishedFromId, taper));
		expect(refurbs).toHaveLength(0);
	});

	test("cancelling lets the unit go; it can't come back once received", async () => {
		const o = await returnedOrder();
		const [id] = await startBench(db, { ...o, quantity: 1 });
		await moveRepair(db, id, "cancelled");
		expect(await due(o.lineId)).toBe(2);
		await receiveReturn(db, {
			...o,
			lines: [{ lineId: o.lineId, quantity: 2 }],
			outcome: "restock",
		});
		await expect(moveRepair(db, id, "received")).rejects.toThrow(
			/received since/,
		);
	});

	test("a bench job leaves the board only by being listed", async () => {
		const [id] = await startBench(db, { productId: taper });
		await expect(moveRepair(db, id, "picked_up")).rejects.toThrow(
			/List it as a refurb/,
		);
		const state = { bench: true, hasDraft: false, paid: false };
		expect(refuseMove({ ...state, status: "ready" }, "in_repair")).toBeNull();
		expect(refuseMove({ ...state, status: "refurbished" }, "ready")).toMatch(
			/Already listed/,
		);
		expect(
			refuseMove({ ...state, bench: false, status: "ready" }, "refurbished"),
		).toMatch(/our own/);
		// No draft order is ever made for it.
		await setPart(db, id, blade, 1);
		const parts = await db
			.select()
			.from(repairParts)
			.where(and(eq(repairParts.repairId, id)));
		expect(parts).toHaveLength(1);
		expect((await job(id)).draftOrderId).toBeNull();
	});
});
