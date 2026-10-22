import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { createProduct, createTestDb } from "#/test/db";
import type { Found } from "./channel";
import {
	applyStockPull,
	markLedgers,
	planStockPull,
	type StoreRead,
	storesInTrustOrder,
} from "./pull";

let db: Db;
let warehouse: number;
let shop: number;
let tiktok: number;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	[{ id: shop }, { id: tiktok }] = await db
		.insert(schema.stores)
		.values([
			{ channel: "shopify", name: "Shop" },
			{ channel: "tiktok", name: "TikTok" },
		])
		.returning();
});

async function list(
	storeId: number,
	externalId: string,
	productId: number,
	status: string | null = null,
) {
	await db.insert(schema.listings).values({
		storeId,
		externalId,
		externalSku: externalId,
		title: externalId,
		productId,
		fulfillment: "merchant",
		status,
	});
}

const ready = (shows: number | null): Found<unknown> => ({
	state: "ready",
	target: {},
	shows,
});

function reads(
	shopFound: Record<string, Found<unknown>>,
	tiktokFound: Record<string, Found<unknown>> = {},
): StoreRead[] {
	return [
		{ storeId: shop, store: "Shop", found: new Map(Object.entries(shopFound)) },
		{
			storeId: tiktok,
			store: "TikTok",
			found: new Map(Object.entries(tiktokFound)),
		},
	];
}

async function onHand(productId: number) {
	const rows = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, productId));
	return rows.reduce((n, r) => n + r.onHand, 0);
}

test("takes the primary store's number for a product with no stock record", async () => {
	const a = await createProduct(db, "A", "simple");
	await list(shop, "s1", a);
	await list(tiktok, "t1", a);
	const plan = await planStockPull(
		db,
		reads({ s1: ready(4) }, { t1: ready(9) }),
	);
	expect(plan.pulls).toEqual([
		{ productId: a, sku: "A", quantity: 4, store: "Shop", disagreed: false },
	]);
	expect(await applyStockPull(db, plan)).toEqual({
		state: "posted",
		posted: 1,
	});
	expect(await onHand(a)).toBe(4);
});

test("falls back to the next store when the first doesn't track it", async () => {
	const a = await createProduct(db, "A", "simple");
	const b = await createProduct(db, "B", "simple");
	await list(shop, "s1", a);
	await list(tiktok, "t1", a);
	await list(shop, "s2", b);
	const plan = await planStockPull(
		db,
		reads(
			{
				s1: { state: "unpushable", reason: "doesn't track" },
				s2: { state: "unpushable", reason: "doesn't track" },
			},
			{ t1: ready(3) },
		),
	);
	expect(plan.pulls.map((p) => [p.sku, p.quantity, p.store])).toEqual([
		["A", 3, "TikTok"],
	]);
	expect(plan.unpulled).toEqual([
		{ sku: "B", why: "untracked", detail: "Shop: doesn't track" },
	]);
});

test("a product that only sold since lands on the channel's number, which already has those sales off", async () => {
	// Another product's movements first, so ids don't line up by chance.
	const other = await createProduct(db, "OTHER", "simple");
	await postMovements(db, {
		lines: [
			{ productId: other, locationId: warehouse, delta: 4, reason: "receipt" },
			{ productId: other, locationId: warehouse, delta: -1, reason: "sale" },
		],
	});
	const a = await createProduct(db, "A", "simple");
	await list(shop, "s1", a);
	await postMovements(db, {
		lines: [{ productId: a, locationId: warehouse, delta: -3, reason: "sale" }],
	});
	const plan = await planStockPull(db, reads({ s1: ready(5) }));
	expect(await applyStockPull(db, plan)).toEqual({
		state: "posted",
		posted: 1,
	});
	expect(await onHand(a)).toBe(5);
});

test("a sale after the stores were read refuses the whole plan", async () => {
	const a = await createProduct(db, "A", "simple");
	await list(shop, "s1", a);
	const mark = await markLedgers(db);
	await postMovements(db, {
		lines: [{ productId: a, locationId: warehouse, delta: -3, reason: "sale" }],
	});
	const plan = await planStockPull(db, reads({ s1: ready(5) }), mark);
	expect(await applyStockPull(db, plan)).toEqual({
		state: "moved",
		skus: ["A"],
	});
	expect(await onHand(a)).toBe(-3);
});

test("never touches a product katasync already has stock history for", async () => {
	const a = await createProduct(db, "A", "simple");
	await list(shop, "s1", a);
	await postMovements(db, {
		lines: [
			{
				productId: a,
				locationId: warehouse,
				delta: 2,
				reason: "opening_balance",
			},
		],
	});
	await postMovements(db, {
		lines: [{ productId: a, locationId: warehouse, delta: -2, reason: "sale" }],
	});
	const plan = await planStockPull(db, reads({ s1: ready(7) }));
	expect(plan).toMatchObject({ pulls: [], unpulled: [] });
});

test("leaves placeholder quantities, bundles, and deleted listings out", async () => {
	const a = await createProduct(db, "A", "simple");
	const pair = await createProduct(db, "PAIR", "bundle");
	const c = await createProduct(db, "C", "simple");
	await list(shop, "s1", a);
	await list(shop, "s2", pair);
	await list(shop, "s3", c, "DELETED");
	const plan = await planStockPull(
		db,
		reads({ s1: ready(999), s2: ready(5), s3: ready(5) }),
	);
	expect(plan.pulls).toEqual([]);
	expect(plan.unpulled).toEqual([
		{ sku: "A", why: "placeholder", detail: "Shop shows 999" },
	]);
});

test("takes the lowest when a store's listings disagree, and runs only once", async () => {
	const a = await createProduct(db, "A", "simple");
	await list(shop, "s1", a);
	await list(shop, "s2", a);
	const plan = await planStockPull(db, reads({ s1: ready(5), s2: ready(2) }));
	expect(plan.pulls[0]).toMatchObject({ quantity: 2, disagreed: true });
	expect(await applyStockPull(db, plan)).toEqual({
		state: "posted",
		posted: 1,
	});
	// Applying the same plan again finds the ledger moved on and posts nothing.
	expect(await applyStockPull(db, plan)).toEqual({
		state: "moved",
		skus: ["A"],
	});
	expect(await onHand(a)).toBe(2);
});

test("the primary store is trusted first, so its zero beats another store's number", async () => {
	await db
		.update(schema.stores)
		.set({ primary: true })
		.where(eq(schema.stores.id, tiktok));
	const a = await createProduct(db, "A", "simple");
	await list(shop, "s1", a);
	await list(tiktok, "t1", a);
	const byId = new Map(
		reads({ s1: ready(9) }, { t1: ready(0) }).map((r) => [r.storeId, r]),
	);
	const trusted = (await storesInTrustOrder(db)).flatMap(
		(s) => byId.get(s.id) ?? [],
	);
	expect(trusted.map((r) => r.store)).toEqual(["TikTok", "Shop"]);
	const plan = await planStockPull(db, trusted);
	expect(plan.pulls).toMatchObject([
		{ sku: "A", quantity: 0, store: "TikTok" },
	]);
});
