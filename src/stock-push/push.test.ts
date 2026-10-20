import { type } from "arktype";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { markNotCounted, UNLIMITED } from "#/inventory/not-counted";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import type { Found, StockChannel, StockWrite } from "./channel";
import { pushChannelStock, pushStoreStock, READ_EVERY_MS } from "./push";
import { stockPushStatus } from "./status";

const target = type({ slot: "string" });
type Target = typeof target.infer;

// A channel kept in memory: what it shows per listing, which listings it
// refuses, and every write it was sent.
function fakeChannel(shows: Record<string, number | null | "unpushable">) {
	const refuse = new Set<string>();
	const writes: StockWrite<Target>[] = [];
	let reads = 0;
	const channel: StockChannel<Target> = {
		name: "Fake",
		target,
		async read() {
			reads++;
			const found = new Map<string, Found<Target>>();
			for (const [id, q] of Object.entries(shows))
				found.set(
					id,
					q === "unpushable"
						? { state: "unpushable", reason: "it can't hold stock" }
						: { state: "ready", target: { slot: `slot-${id}` }, shows: q },
				);
			return found;
		},
		async write(list) {
			writes.push(...list);
			const failures = new Map<string, string>();
			for (const w of list) {
				if (refuse.has(w.externalId)) failures.set(w.externalId, "nope");
				else shows[w.externalId] = w.quantity;
			}
			return failures;
		},
	};
	return { channel, shows, refuse, writes, reads: () => reads };
}

let db: Db;
let warehouse: number;
let store: typeof schema.stores.$inferSelect;

async function stock(productId: number, delta: number) {
	await postMovements(db, {
		lines: [
			{ productId, locationId: warehouse, delta, reason: "opening_balance" },
		],
	});
}

async function list(
	externalId: string,
	productId: number | null,
	fulfillment: "merchant" | "fba" = "merchant",
	status: string | null = null,
) {
	await db.insert(schema.listings).values({
		storeId: store.id,
		externalId,
		externalSku: externalId,
		title: externalId,
		productId,
		fulfillment,
		status,
	});
}

async function reload() {
	[store] = await db
		.select()
		.from(schema.stores)
		.where(eq(schema.stores.id, store.id));
	return store;
}

async function listingPush(externalId: string) {
	const [row] = await db
		.select({ stockPush: schema.listings.stockPush })
		.from(schema.listings)
		.where(eq(schema.listings.externalId, externalId));
	return row.stockPush;
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

describe("pushStoreStock", () => {
	test("shows none at or below a product's close-at, and every unit above it", async () => {
		const low = await createProduct(db, "LOW", "simple");
		const high = await createProduct(db, "HIGH", "simple");
		const free = await createProduct(db, "FREE", "simple");
		await db
			.update(schema.products)
			.set({ closeAt: 2 })
			.where(inArray(schema.products.id, [low, high, free]));
		await stock(low, 2);
		await stock(high, 3);
		await markNotCounted(db, [free]);
		await list("1", low);
		await list("2", high);
		await list("3", free);
		const fake = fakeChannel({ "1": 2, "2": 0, "3": 0 });
		await pushStoreStock(db, store, fake.channel, "write");
		expect(fake.shows).toEqual({ "1": 0, "2": 3, "3": UNLIMITED });
	});

	test("writes only the listings whose quantity differs, then remembers it", async () => {
		const a = await createProduct(db, "A", "simple");
		const b = await createProduct(db, "B", "simple");
		await stock(a, 5);
		await stock(b, 3);
		await list("1", a);
		await list("2", b);
		const fake = fakeChannel({ "1": 2, "2": 3 });

		const result = await pushStoreStock(db, store, fake.channel, "write");
		expect(result.changes).toEqual([
			{ sku: "A", externalId: "1", from: 2, to: 5 },
		]);
		expect(fake.writes).toEqual([
			{ externalId: "1", target: { slot: "slot-1" }, quantity: 5 },
		]);
		expect(await listingPush("1")).toMatchObject({
			state: "ready",
			shows: 5,
			error: null,
		});
		expect((await reload()).stockPushedAt).not.toBeNull();

		// Nothing changed, so the next pass writes nothing and doesn't read.
		fake.writes.length = 0;
		await pushStoreStock(db, await reload(), fake.channel, "write");
		expect(fake.writes).toEqual([]);
		expect(fake.reads()).toBe(1);
	});

	test("a bundle sells as many as its scarcest part allows; oversold stock is 0", async () => {
		const part = await createProduct(db, "PART", "simple");
		const pair = await createProduct(db, "PAIR", "bundle");
		const gone = await createProduct(db, "GONE", "simple");
		await setRecipe(db, pair, [{ productId: part, quantity: 2 }]);
		await stock(part, 5);
		await stock(gone, -2);
		await list("pair", pair);
		await list("gone", gone);
		const fake = fakeChannel({ pair: null, gone: 4 });

		await pushStoreStock(db, store, fake.channel, "write");
		expect(
			Object.fromEntries(fake.writes.map((w) => [w.externalId, w.quantity])),
		).toEqual({
			pair: 2,
			gone: 0,
		});
	});

	test("leaves unmapped and FBA listings alone", async () => {
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("loose", null);
		await list("fba", a, "fba");
		const fake = fakeChannel({ loose: 1, fba: 1 });

		const result = await pushStoreStock(db, store, fake.channel, "write");
		expect(fake.writes).toEqual([]);
		expect(result.problems).toEqual([]);
	});

	test("leaves deleted listings alone", async () => {
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("gone", a, "merchant", "DELETED");
		await list("live", a, "merchant", "ACTIVATE");
		const fake = fakeChannel({ gone: 1, live: 1 });

		const result = await pushStoreStock(db, store, fake.channel, "write");
		expect(fake.writes.map((w) => w.externalId)).toEqual(["live"]);
		expect(result.problems).toEqual([]);
	});

	test("a refused write is kept, reported, and tried again until it goes through", async () => {
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("1", a);
		const fake = fakeChannel({ "1": 1 });
		fake.refuse.add("1");

		const first = await pushStoreStock(db, store, fake.channel, "write");
		expect(first.failed).toBe(1);
		expect(first.problems).toEqual(["A: Fake refused its stock: nope"]);
		expect(await listingPush("1")).toMatchObject({ shows: 1, error: "nope" });

		fake.refuse.clear();
		const second = await pushStoreStock(db, store, fake.channel, "write");
		expect(second.problems).toEqual([]);
		expect(await listingPush("1")).toMatchObject({ shows: 5, error: null });
	});

	test("preview works out the changes and writes nothing", async () => {
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("1", a);
		const fake = fakeChannel({ "1": 1 });

		const result = await pushStoreStock(db, store, fake.channel, "preview");
		expect(result.changes).toHaveLength(1);
		expect(fake.writes).toEqual([]);
		expect(await listingPush("1")).toMatchObject({ shows: 1 });
		expect((await reload()).stockPushedAt).toBeNull();
		expect(result.problems[0]).toMatch(/preview only/);
	});

	test("reads the channel again once the last read is old, putting drift right", async () => {
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("1", a);
		const fake = fakeChannel({ "1": 5 });
		const start = new Date();
		await pushStoreStock(db, store, fake.channel, "write", start);
		expect(fake.writes).toEqual([]);

		// Someone edits the quantity on the channel.
		fake.shows["1"] = 9;
		await pushStoreStock(
			db,
			await reload(),
			fake.channel,
			"write",
			new Date(start.getTime() + 60_000),
		);
		expect(fake.writes).toEqual([]);
		await pushStoreStock(
			db,
			await reload(),
			fake.channel,
			"write",
			new Date(start.getTime() + READ_EVERY_MS),
		);
		expect(fake.writes.map((w) => w.quantity)).toEqual([5]);
		expect(fake.reads()).toBe(2);
	});

	test("listings it can't set, or the channel didn't report, are problems", async () => {
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("odd", a);
		await list("missing", a);
		const fake = fakeChannel({ odd: "unpushable" });

		const result = await pushStoreStock(db, store, fake.channel, "write");
		expect(fake.writes).toEqual([]);
		expect([...result.problems].sort()).toEqual([
			"A: Fake didn't report this listing's stock, so katasync isn't setting it",
			"A: katasync can't set its Fake stock: it can't hold stock",
		]);
	});

	test("a listing made since the last read is read and set in the same pass", async () => {
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("1", a);
		const fake = fakeChannel({ "1": 5 });
		const start = new Date();
		await pushStoreStock(db, store, fake.channel, "write", start);
		expect(fake.reads()).toBe(1);

		// A new product and its listing arrive well before the next read is due.
		const b = await createProduct(db, "B", "simple");
		await stock(b, 3);
		await list("2", b);
		fake.shows["2"] = 0;
		const result = await pushStoreStock(
			db,
			await reload(),
			fake.channel,
			"write",
			new Date(start.getTime() + 60_000),
		);
		expect(fake.reads()).toBe(2);
		expect(result.problems).toEqual([]);
		expect(fake.writes).toEqual([
			{ externalId: "2", target: { slot: "slot-2" }, quantity: 3 },
		]);
	});

	test("a push of what moved reads first only when one of its listings is new", async () => {
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("1", a);
		const fake = fakeChannel({ "1": 5 });
		const start = new Date();
		await pushStoreStock(db, store, fake.channel, "write", start);

		// A received on a PO: its listing is known, so no read.
		await stock(a, 1);
		const later = new Date(start.getTime() + 60_000);
		await pushStoreStock(db, await reload(), fake.channel, "write", later, [a]);
		expect(fake.reads()).toBe(1);
		expect(fake.writes.map((w) => w.quantity)).toEqual([6]);

		// A new product's listing has never been read, so this push reads.
		const b = await createProduct(db, "B", "simple");
		await stock(b, 3);
		await list("2", b);
		fake.shows["2"] = 0;
		const result = await pushStoreStock(
			db,
			await reload(),
			fake.channel,
			"write",
			later,
			[b],
		);
		expect(fake.reads()).toBe(2);
		expect(result.problems).toEqual([]);
		expect(fake.writes.at(-1)).toEqual({
			externalId: "2",
			target: { slot: "slot-2" },
			quantity: 3,
		});
	});

	test("a listing the channel didn't report waits for the next due read", async () => {
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("missing", a);
		const fake = fakeChannel({});
		const start = new Date();
		const problem =
			"A: Fake didn't report this listing's stock, so katasync isn't setting it";

		const first = await pushStoreStock(db, store, fake.channel, "write", start);
		expect(first.problems).toEqual([problem]);
		expect(await listingPush("missing")).toEqual({ state: "unreported" });

		const second = await pushStoreStock(
			db,
			await reload(),
			fake.channel,
			"write",
			new Date(start.getTime() + 60_000),
		);
		expect(second.problems).toEqual([problem]);
		expect(fake.reads()).toBe(1);

		await pushStoreStock(
			db,
			await reload(),
			fake.channel,
			"write",
			new Date(start.getTime() + READ_EVERY_MS),
		);
		expect(fake.reads()).toBe(2);
	});

	test("won't push while a store's orders don't take stock", async () => {
		await db
			.insert(schema.stores)
			.values({ channel: "ebay", name: "Old eBay" });
		const a = await createProduct(db, "A", "simple");
		await stock(a, 5);
		await list("1", a);
		const fake = fakeChannel({ "1": 0 });

		const result = await pushStoreStock(db, store, fake.channel, "write");
		expect(fake.reads()).toBe(0);
		expect(fake.writes).toEqual([]);
		expect(result.problems[0]).toMatch(/Old eBay doesn't take stock/);
		expect((await reload()).stockPushError).toMatch(/Old eBay/);
	});

	test("a channel that fails stops that store's pass and says why", async () => {
		const fake = fakeChannel({});
		fake.channel.read = async () => {
			throw new Error("Access denied: write_inventory");
		};
		const result = await pushStoreStock(db, store, fake.channel, "write");
		expect(result.problems).toEqual([
			"Stock push to Shop stopped: Access denied: write_inventory",
		]);
		expect((await reload()).stockPushError).toBe(
			"Access denied: write_inventory",
		);
	});
});

test("pushChannelStock skips stores with push off", async () => {
	await db.update(schema.stores).set({ pushStock: false });
	const fake = fakeChannel({});
	expect(await pushChannelStock(db, "shopify", fake.channel, "write")).toEqual(
		[],
	);
	expect(fake.reads()).toBe(0);
});

describe("stockPushStatus", () => {
	const row = {
		on: true,
		pushedAt: null,
		error: null,
		listed: 12,
		mapped: 10,
		ready: 8,
		failing: 0,
	};
	const live = { writes: true, blocker: null };

	test("reads each state one way", () => {
		expect(stockPushStatus({ ...row, on: false }, live).kind).toBe("off");
		expect(stockPushStatus(row, { ...live, blocker: "no stock" }).kind).toBe(
			"blocked",
		);
		expect(stockPushStatus({ ...row, error: "denied" }, live).kind).toBe(
			"stopped",
		);
		expect(stockPushStatus({ ...row, listed: 0 }, live).kind).toBe("unlisted");
		expect(stockPushStatus(row, { ...live, writes: false }).kind).toBe(
			"preview",
		);
		expect(stockPushStatus(row, live).kind).toBe("starting");
		expect(
			stockPushStatus({ ...row, pushedAt: new Date() }, live),
		).toMatchObject({
			kind: "pushing",
			ready: 8,
			mapped: 10,
		});
	});
});
