import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { planStockPull } from "#/stock-push/pull";
import { createProduct, createTestDb } from "#/test/db";
import { refreshFromSumtracker } from "./refresh";
import type { ImportPlan } from "./sumtracker";

let db: Db;
let shelf: number;
let store: number;

const exportedAt = new Date("2026-10-20T12:00:00Z");

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shelf }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	[{ id: store }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shop", stockFrom: new Date(0) })
		.returning();
});

const item = (
	sku: string,
	extra: Partial<ImportPlan["products"][number]> = {},
): ImportPlan["products"][number] => ({
	sku,
	name: sku,
	kind: "simple",
	groupName: null,
	variantName: null,
	imageUrl: null,
	category: null,
	barcode: null,
	unitCost: null,
	...extra,
});

function plan(extra: Partial<ImportPlan> = {}): ImportPlan {
	return {
		groups: [],
		products: [],
		recipes: new Map(),
		aliases: [],
		openingStock: [],
		shelves: [],
		warnings: [],
		...extra,
	};
}

const options = { exportedAt, unlimited: [], countFirst: [] };

async function sold(productId: number, placedAt: Date, quantity: number) {
	const n = placedAt.getTime();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store,
			externalId: `o${n}`,
			name: `#${n}`,
			placedAt,
			fulfillmentStatus: "unfulfilled",
			total: 10,
			sourceUpdatedAt: placedAt,
		})
		.returning();
	await db.insert(schema.orderLines).values({
		orderId: order.id,
		externalId: `l${n}`,
		productId,
		title: "x",
		quantity,
		unitPrice: 10,
	});
}

async function onHand(productId: number) {
	const rows = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, productId));
	return rows.reduce((n, r) => n + r.onHand, 0);
}

test("starts stock over from the export and takes again only the sales since", async () => {
	const a = await createProduct(db, "A", "simple");
	await postMovements(db, {
		lines: [{ productId: a, locationId: shelf, delta: 40, reason: "receipt" }],
	});
	await sold(a, new Date("2026-10-19T00:00:00Z"), 5);
	await sold(a, new Date("2026-10-20T13:00:00Z"), 2);
	const [{ id: supplier }] = await db
		.insert(schema.suppliers)
		.values({ name: "S", code: "S" })
		.returning();
	await db
		.insert(schema.purchaseOrders)
		.values({ supplierId: supplier, locationId: shelf });

	const result = await refreshFromSumtracker(
		db,
		plan({
			products: [item("A")],
			shelves: [{ sku: "A", inStock: 12, booked: 2, closeAt: null }],
		}),
		options,
	);
	// 12 on the shelf less 2 booked at the export, less the one order
	// placed after it.
	expect(await onHand(a)).toBe(8);
	expect(result.salesRetaken).toBe(1);
	expect(await db.select().from(schema.purchaseOrders)).toEqual([]);
	const [s] = await db.select().from(schema.stores);
	expect(s.stockFrom).toEqual(exportedAt);
	// Orders stay, and the product keeps its id.
	expect(await db.select().from(schema.orders)).toHaveLength(2);
	expect(result.added).toEqual([]);
});

test("refuses to discard invoice evidence, even on a draft", async () => {
	const product = await createProduct(db, "PRESERVED", "simple");
	await postMovements(db, {
		lines: [
			{
				productId: product,
				locationId: shelf,
				delta: 4,
				reason: "opening_balance",
			},
		],
	});
	const [supplier] = await db
		.insert(schema.suppliers)
		.values({ name: "Evidence", code: "EVIDENCE" })
		.returning();
	const [order] = await db
		.insert(schema.purchaseOrders)
		.values({ supplierId: supplier.id, locationId: shelf })
		.returning();
	await db.insert(schema.supplierInvoices).values({
		purchaseOrderId: order.id,
		supplierId: supplier.id,
		number: "KEPT",
		invoicedOn: "2026-10-01",
		total: 10,
	});
	await expect(
		refreshFromSumtracker(db, plan({ products: [item("PRESERVED")] }), options),
	).rejects.toThrow(/Purchasing evidence.*Nothing changed/);
	expect(await onHand(product)).toBe(4);
	expect(await db.select().from(schema.supplierInvoices)).toHaveLength(1);
	expect(await db.select().from(schema.purchaseOrders)).toHaveLength(1);
});

test("refuses to discard a sent purchase order without an invoice", async () => {
	const [supplier] = await db
		.insert(schema.suppliers)
		.values({ name: "Sent", code: "SENT" })
		.returning();
	await db
		.insert(schema.purchaseOrders)
		.values({ supplierId: supplier.id, locationId: shelf, status: "sent" });
	await expect(refreshFromSumtracker(db, plan({}), options)).rejects.toThrow(
		/Purchasing evidence.*Nothing changed/,
	);
	expect(await db.select().from(schema.purchaseOrders)).toHaveLength(1);
});

test("can discard only non-evidence suggested drafts during cutover", async () => {
	const [supplier] = await db
		.insert(schema.suppliers)
		.values({ name: "Suggested", code: "SUGGESTED" })
		.returning();
	await db.insert(schema.purchaseOrders).values({
		supplierId: supplier.id,
		locationId: shelf,
		status: "suggested",
	});
	await expect(
		refreshFromSumtracker(db, plan({}), options),
	).resolves.toBeDefined();
	expect(await db.select().from(schema.purchaseOrders)).toHaveLength(0);
});

test("fills in and changes details by SKU, never blanks one, and adds what's new", async () => {
	const a = await createProduct(db, "A", "simple");
	await db
		.update(schema.products)
		.set({ imageUrl: "ours.png", unitCost: 3 })
		.where(eq(schema.products.id, a));
	await createProduct(db, "OURS", "simple");
	const result = await refreshFromSumtracker(
		db,
		plan({
			products: [
				item("A", { name: "Better name", unitCost: 4.5 }),
				item("NEW", { category: "Blade" }),
			],
		}),
		options,
	);
	const [p] = await db
		.select()
		.from(schema.products)
		.where(eq(schema.products.id, a));
	expect(p).toMatchObject({
		name: "Better name",
		imageUrl: "ours.png",
		unitCost: 4.5,
	});
	expect(result.added).toEqual(["NEW"]);
	expect(result.untouched).toEqual(["OURS"]);
});

test("refuses a product whose kind changed, and changes nothing", async () => {
	const a = await createProduct(db, "A", "simple");
	await postMovements(db, {
		lines: [{ productId: a, locationId: shelf, delta: 4, reason: "receipt" }],
	});
	await expect(
		refreshFromSumtracker(
			db,
			plan({ products: [item("A", { kind: "bundle" })] }),
			options,
		),
	).rejects.toThrow(/Nothing changed/);
	expect(await onHand(a)).toBe(4);
});

test("marks the unlimited and puts the rest on the count list, refusing unknown SKUs", async () => {
	const a = await createProduct(db, "A", "simple");
	const b = await createProduct(db, "B", "simple");
	await refreshFromSumtracker(db, plan({ products: [item("A"), item("B")] }), {
		...options,
		unlimited: ["A"],
		countFirst: ["B"],
	});
	const rows = await db.select().from(schema.products);
	expect(rows.find((r) => r.id === a)?.notCountedSince).not.toBeNull();
	expect(rows.find((r) => r.id === b)?.notCountedSince).toBeNull();
	const levels = await db.select().from(schema.stockLevels);
	expect(levels.map((l) => [l.productId, l.countRequestedAt !== null])).toEqual(
		expect.arrayContaining([
			[a, true],
			[b, true],
		]),
	);
	await expect(
		refreshFromSumtracker(db, plan({ products: [item("A")] }), {
			...options,
			countFirst: ["TYPO"],
		}),
	).rejects.toThrow(/TYPO/);
});

test("records the export's empty shelves, so a stock pull leaves them at 0", async () => {
	const empty = await createProduct(db, "EMPTY", "simple");
	const unknown = await createProduct(db, "UNKNOWN", "simple");
	for (const [id, ext] of [
		[empty, "e"],
		[unknown, "u"],
	] as const)
		await db.insert(schema.listings).values({
			storeId: store,
			externalId: ext,
			externalSku: ext,
			title: ext,
			productId: id,
			fulfillment: "merchant",
		});
	await refreshFromSumtracker(
		db,
		plan({
			products: [item("EMPTY")],
			shelves: [{ sku: "EMPTY", inStock: 0, booked: 0, closeAt: null }],
		}),
		options,
	);
	const found = new Map([
		["e", { state: "ready" as const, target: {}, shows: 5 }],
		["u", { state: "ready" as const, target: {}, shows: 5 }],
	]);
	const pull = await planStockPull(db, [
		{ storeId: store, store: "Shop", found },
	]);
	expect(pull.pulls.map((p) => p.sku)).toEqual(["UNKNOWN"]);
	expect(await onHand(empty)).toBe(0);
});
