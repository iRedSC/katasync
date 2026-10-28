import { type } from "arktype";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { stockCommitmentEntries, stockCommitments } from "#/db/quantity-schema";
import * as schema from "#/db/schema";
import {
	activate,
	channelOrder,
	quantityWorld,
} from "#/inventory/commitments.fixtures";
import { postMovements } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import type { Found, StockChannel, StockWrite } from "./channel";
import { movedSince, pushMoved, pushProductsNow } from "./on-change";

const target = type({ slot: "string" });

let db: Db;
let warehouse: number;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Main", kind: "owned" })
		.returning();
});

const opening = (productId: number, delta: number) =>
	postMovements(db, {
		lines: [
			{ productId, locationId: warehouse, delta, reason: "opening_balance" },
		],
	});

// A channel that shows `shows` for each listing and records what it's sent.
function channel(shows: Record<string, number>) {
	const writes: StockWrite<{ slot: string }>[] = [];
	const adapter: StockChannel<{ slot: string }> = {
		name: "Fake",
		target,
		async read() {
			throw new Error("a push of moved stock reads nothing");
		},
		async write(list) {
			writes.push(...list);
			return new Map();
		},
	};
	return { adapter: adapter as unknown as StockChannel<never>, writes, shows };
}

async function store(
	channelName: "shopify" | "tiktok",
	listed: [string, number, number][],
	pushStock = true,
) {
	const [s] = await db
		.insert(schema.stores)
		.values({
			channel: channelName,
			name: channelName,
			pushStock,
			stockFrom: new Date(0),
		})
		.returning();
	for (const [externalId, productId, shows] of listed)
		await db.insert(schema.listings).values({
			storeId: s.id,
			externalId,
			externalSku: externalId,
			title: externalId,
			productId,
			fulfillment: "merchant",
			stockPush: {
				state: "ready",
				target: { slot: externalId },
				shows,
				error: null,
			} satisfies Found<unknown> & { error: null },
		});
	return s;
}

test("finds what moved, and the sets made from it", async () => {
	const part = await createProduct(db, "PART", "simple");
	const still = await createProduct(db, "STILL", "simple");
	const set = await createProduct(db, "SET", "bundle");
	await setRecipe(db, set, [{ productId: part, quantity: 2 }]);
	await opening(still, 3);
	const before = new Date(Date.now() + 5 * 60 * 1000);
	expect(await movedSince(db, before)).toEqual([]);
	await opening(part, 4);
	expect((await movedSince(db, new Date())).sort()).toEqual(
		[part, still, set].sort(),
	);
});

test("pushes only what moved, to every store with push on but the one left out", async () => {
	const sold = await createProduct(db, "SOLD", "simple");
	const other = await createProduct(db, "OTHER", "simple");
	await opening(other, 5);
	const shop = channel({});
	const tiktok = channel({});
	await store("shopify", [
		["s-sold", sold, 9],
		["s-other", other, 1],
	]);
	await store("tiktok", [["t-sold", sold, 9]]);
	const since = new Date();
	await opening(sold, 3);

	await pushMoved(db, since, {
		mode: "write",
		adapters: { shopify: shop.adapter, tiktok: tiktok.adapter },
	});
	// OTHER moved too (within the slack), and Shopify shows 1 of its 5.
	expect(shop.writes.map((w) => [w.externalId, w.quantity]).sort()).toEqual([
		["s-other", 5],
		["s-sold", 3],
	]);
	expect(tiktok.writes.map((w) => [w.externalId, w.quantity])).toEqual([
		["t-sold", 3],
	]);

	shop.writes.length = 0;
	tiktok.writes.length = 0;
	await opening(sold, -1);
	await pushMoved(db, since, {
		except: "shopify",
		mode: "write",
		adapters: { shopify: shop.adapter, tiktok: tiktok.adapter },
	});
	expect(shop.writes).toEqual([]);
	expect(tiktok.writes.map((w) => [w.externalId, w.quantity])).toEqual([
		["t-sold", 2],
	]);
});

test("pushes a set whose parts changed, though no stock moved", async () => {
	const part = await createProduct(db, "PART", "simple");
	const set = await createProduct(db, "SET", "bundle");
	await setRecipe(db, set, [{ productId: part, quantity: 1 }]);
	await opening(part, 6);
	const shop = channel({});
	await store("shopify", [["s-set", set, 6]]);

	await setRecipe(db, set, [{ productId: part, quantity: 2 }]);
	await pushProductsNow(db, [set], {
		mode: "write",
		adapters: { shopify: shop.adapter },
	});
	expect(shop.writes.map((w) => [w.externalId, w.quantity])).toEqual([
		["s-set", 3],
	]);
});

describe("once committed", () => {
	let world: Awaited<ReturnType<typeof quantityWorld>>;

	beforeEach(async () => {
		world = await quantityWorld(db);
		await activate(db);
	});

	test("a sale that only reserves reaches the other channels", async () => {
		// Never stocked, so nothing but the order can have moved it.
		const wrench = await createProduct(db, "WRENCH", "simple");
		const tiktok = channel({});
		await store("tiktok", [["t-wrench", wrench, 2]]);
		const since = new Date();
		expect(await movedSince(db, since)).toEqual([]);

		await world.ingest(channelOrder());
		expect(await movedSince(db, since)).toEqual([wrench]);
		await pushMoved(db, since, {
			except: "shopify",
			mode: "write",
			adapters: { tiktok: tiktok.adapter },
		});
		expect(tiktok.writes.map((w) => [w.externalId, w.quantity])).toEqual([
			["t-wrench", 0],
		]);
	});

	test("a released reservation counts as a move", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await world.ingest(channelOrder());
		const later = new Date(Date.now() + 10 * 60 * 1000);
		expect(await movedSince(db, later)).toEqual([]);

		// A cancel well after the order, as if it came in ten minutes on.
		const [commitment] = await db
			.select({ id: stockCommitments.id })
			.from(stockCommitments);
		await db.insert(stockCommitmentEntries).values({
			commitmentId: commitment.id,
			kind: "release",
			quantity: 3,
			createdAt: later,
		});
		expect(await movedSince(db, later)).toEqual([wrench]);
	});
});
