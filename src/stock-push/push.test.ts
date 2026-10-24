import { type } from "arktype";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { markNotCounted, UNLIMITED } from "#/inventory/not-counted";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import type { Found, StockChannel } from "./channel";
import { STOCK_WRITE_HOLD } from "./policy";
import {
	pushChannelStock,
	pushMode,
	pushStoreStock,
	READ_EVERY_MS,
} from "./push";
import { stockPushStatus } from "./status";
import { setStorePush } from "./switch";

const target = type({ slot: "string" });
type Target = typeof target.infer;
function fakeChannel(shows: Record<string, number | null | "unpushable">) {
	let reads = 0;
	const write = vi.fn();
	const channel: StockChannel<Target> = {
		name: "Fake",
		target,
		async read() {
			reads++;
			return new Map(
				Object.entries(shows).map(
					([externalId, quantity]): [string, Found<Target>] => [
						externalId,
						quantity === "unpushable"
							? { state: "unpushable", reason: "unsupported address" }
							: {
									state: "ready",
									target: { slot: externalId },
									shows: quantity,
								},
					],
				),
			);
		},
	};
	Object.assign(channel, { write });
	return { channel, shows, write, reads: () => reads };
}
let db: Db;
let warehouse: number;
let store: typeof schema.stores.$inferSelect;
const stock = (productId: number, delta: number) =>
	postMovements(db, {
		lines: [
			{ productId, locationId: warehouse, delta, reason: "opening_balance" },
		],
	});
async function list(
	externalId: string,
	productId: number | null,
	more: Partial<typeof schema.listings.$inferInsert> = {},
) {
	await db.insert(schema.listings).values({
		storeId: store.id,
		externalId,
		externalSku: externalId,
		title: externalId,
		productId,
		...more,
	});
}
async function state(externalId: string) {
	const [row] = await db
		.select()
		.from(schema.listings)
		.where(eq(schema.listings.externalId, externalId));
	return row.stockPush;
}
async function reload() {
	const [row] = await db
		.select()
		.from(schema.stores)
		.where(eq(schema.stores.id, store.id));
	return row;
}
beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	[store] = await db
		.insert(schema.stores)
		.values({
			channel: "shopify",
			name: "Shop",
			pushStock: true,
			stockFrom: new Date(),
		})
		.returning();
});

test.each([
	0,
	2,
	5,
	9,
	null,
])("blocks positive targets against remote %s, including equality and unknown stock", async (shows) => {
	const product = await createProduct(db, "A", "simple");
	await stock(product, 5);
	await list("a", product);
	const fake = fakeChannel({ a: shows });
	const result = await pushStoreStock(db, store, fake.channel, "preview");
	expect(result.blocked).toBe(1);
	expect(result.problems).toContain(STOCK_WRITE_HOLD);
	expect(result.changes).toEqual(
		shows === 5
			? []
			: [{ sku: "A", externalId: "a", from: shows, to: 5, state: "blocked" }],
	);
	expect(fake.write).not.toHaveBeenCalled();
	expect(fake.shows.a).toBe(shows);
	expect(await state("a")).toMatchObject({
		shows,
		error: STOCK_WRITE_HOLD,
		delivery: { kind: "blocked", wanted: 5 },
	});
	expect((await reload()).stockPushedAt).toBeNull();
});

test("preserves close-at, uncounted, bundle and shortage math without delivering even zero", async () => {
	const low = await createProduct(db, "LOW", "simple"),
		high = await createProduct(db, "HIGH", "simple"),
		free = await createProduct(db, "FREE", "simple"),
		pair = await createProduct(db, "PAIR", "bundle"),
		gone = await createProduct(db, "GONE", "simple");
	await db
		.update(schema.products)
		.set({ closeAt: 2 })
		.where(inArray(schema.products.id, [low, high, free]));
	await setRecipe(db, pair, [{ productId: high, quantity: 2 }]);
	await stock(low, 2);
	await stock(high, 5);
	await stock(gone, -2);
	await markNotCounted(db, [free]);
	for (const [externalId, productId] of [
		["low", low],
		["high", high],
		["free", free],
		["pair", pair],
		["gone", gone],
	] as const)
		await list(externalId, productId);
	const fake = fakeChannel({ low: 9, high: 9, free: 0, pair: null, gone: 9 });
	const result = await pushStoreStock(db, store, fake.channel, "preview");
	expect(
		Object.fromEntries(
			result.changes.map((change) => [change.externalId, change.to]),
		),
	).toEqual({ low: 0, high: 5, free: UNLIMITED, pair: 2, gone: 0 });
	expect(fake.write).not.toHaveBeenCalled();
	expect(await state("gone")).toMatchObject({ shows: 9 });
});

test("excludes unmapped, FBA, deleted and gone listings", async () => {
	const product = await createProduct(db, "A", "simple");
	await stock(product, 5);
	await list("ours", product);
	await list("unmapped", null);
	await list("fba", product, { fulfillment: "fba" });
	await list("deleted", product, { status: "DELETED" });
	await list("gone", product, { goneAt: new Date() });
	const fake = fakeChannel({
		ours: 0,
		unmapped: 0,
		fba: 0,
		deleted: 0,
		gone: 0,
	});
	expect(
		(await pushStoreStock(db, store, fake.channel, "preview")).changes.map(
			(change) => change.externalId,
		),
	).toEqual(["ours"]);
});

test("keeps read caching and explicitly refreshes an off store without enabling it", async () => {
	const product = await createProduct(db, "A", "simple");
	await stock(product, 5);
	await list("a", product);
	const fake = fakeChannel({ a: 5 });
	const start = new Date();
	await pushStoreStock(db, store, fake.channel, "preview", start);
	fake.shows.a = 2;
	await pushStoreStock(
		db,
		await reload(),
		fake.channel,
		"preview",
		new Date(start.getTime() + 1000),
	);
	expect(fake.reads()).toBe(1);
	await pushStoreStock(
		db,
		await reload(),
		fake.channel,
		"preview",
		new Date(start.getTime() + READ_EVERY_MS),
	);
	expect(fake.reads()).toBe(2);
	expect(await state("a")).toMatchObject({ shows: 2 });
	await setStorePush(db, store.id, false);
	fake.shows.a = 1;
	await pushStoreStock(
		db,
		store,
		fake.channel,
		"preview",
		new Date(),
		undefined,
		true,
	);
	expect(fake.reads()).toBe(3);
	expect(await state("a")).toMatchObject({ shows: 1 });
	expect((await reload()).pushStock).toBe(false);
});

test("keeps unsupported and missing observations distinct", async () => {
	const product = await createProduct(db, "A", "simple");
	await list("odd", product);
	await list("missing", product);
	const fake = fakeChannel({ odd: "unpushable" });
	const result = await pushStoreStock(db, store, fake.channel, "preview");
	expect(result.blocked).toBe(0);
	expect(result.problems).toHaveLength(3);
	expect(await state("odd")).toEqual({
		state: "unpushable",
		reason: "unsupported address",
	});
	expect(await state("missing")).toEqual({ state: "unreported" });
});

test("refuses legacy write mode and enabling before touching the channel", async () => {
	const fake = fakeChannel({});
	const result = await pushStoreStock(
		db,
		store,
		fake.channel,
		"write" as never,
	);
	expect(result.problems[0]).toContain(STOCK_WRITE_HOLD);
	expect(fake.reads()).toBe(0);
	expect(fake.write).not.toHaveBeenCalled();
	expect(pushMode()).toBe("preview");
	await setStorePush(db, store.id, false);
	expect(
		await pushChannelStock(db, "shopify", fake.channel, "preview"),
	).toEqual([]);
	await expect(setStorePush(db, store.id, true as never)).rejects.toThrow(
		STOCK_WRITE_HOLD,
	);
});

test("retains prerequisite and read failures without claiming delivery", async () => {
	const fake = fakeChannel({});
	await db.insert(schema.stores).values({ channel: "ebay", name: "Old eBay" });
	expect(
		(await pushStoreStock(db, store, fake.channel, "preview")).problems[0],
	).toContain("Old eBay doesn't take stock");
	expect(fake.reads()).toBe(0);
	await db.update(schema.stores).set({ stockFrom: new Date() });
	fake.channel.read = async () => {
		throw new Error("Read denied");
	};
	expect(
		(await pushStoreStock(db, store, fake.channel, "preview")).problems[0],
	).toContain("Read denied");
	expect((await reload()).stockPushedAt).toBeNull();
});

test("legacy timestamps and quantity equality never imply synchronized stock", () => {
	const row = {
		on: true,
		pushedAt: new Date(),
		error: null,
		listed: 2,
		mapped: 2,
		ready: 2,
		failing: 0,
	};
	expect(stockPushStatus(row, { writes: true, blocker: null })).toEqual({
		kind: "blocked",
		why: STOCK_WRITE_HOLD,
	});
	expect(
		stockPushStatus(
			{ on: false },
			{ writes: false, blocker: STOCK_WRITE_HOLD },
		),
	).toEqual({ kind: "off" });
});
