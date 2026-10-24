import { type } from "arktype";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import type { Found, StockChannel } from "./channel";
import { movedSince, pushMoved } from "./on-change";

const target = type({ slot: "string" });

let db: Db;
let warehouse: number;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
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
	const write = vi.fn();
	const adapter: StockChannel<{ slot: string }> = {
		name: "Fake",
		target,
		async read() {
			throw new Error("a push of moved stock reads nothing");
		},
	};
	Object.assign(adapter, { write });
	return { adapter: adapter as unknown as StockChannel<never>, write, shows };
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

test("plans only moved stock without delivering to any store", async () => {
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

	const first = await pushMoved(db, since, {
		mode: "preview",
		adapters: { shopify: shop.adapter, tiktok: tiktok.adapter },
	});
	// OTHER moved too (within the slack), and Shopify shows 1 of its 5.
	expect(
		first[0].changes.map((change) => [change.externalId, change.to]).sort(),
	).toEqual([
		["s-other", 5],
		["s-sold", 3],
	]);
	expect(
		first[1].changes.map((change) => [change.externalId, change.to]),
	).toEqual([["t-sold", 3]]);

	expect(shop.write).not.toHaveBeenCalled();
	expect(tiktok.write).not.toHaveBeenCalled();
	await opening(sold, -1);
	const second = await pushMoved(db, since, {
		except: "shopify",
		mode: "preview",
		adapters: { shopify: shop.adapter, tiktok: tiktok.adapter },
	});
	expect(shop.write).not.toHaveBeenCalled();
	expect(tiktok.write).not.toHaveBeenCalled();
	expect(second).toHaveLength(1);
	expect(
		second[0].changes.map((change) => [change.externalId, change.to]),
	).toEqual([["t-sold", 2]]);
});
