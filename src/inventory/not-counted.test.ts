import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { getAvailability, getBundleBlockers } from "#/inventory/availability";
import { postMovements, recordCount } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import { markNotCounted, UNLIMITED } from "./not-counted";

let db: Db;
let shelf: number;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shelf }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
});

const notCounted = async (id: number) => {
	const [p] = await db
		.select({ at: schema.products.notCountedSince })
		.from(schema.products)
		.where(eq(schema.products.id, id));
	return p.at !== null;
};

test("sells without limit for push, while its sales still post", async () => {
	const a = await createProduct(db, "A", "simple");
	expect(await markNotCounted(db, [a])).toBe(1);
	await postMovements(db, {
		lines: [{ productId: a, locationId: shelf, delta: -3, reason: "sale" }],
	});
	const pushed = await getAvailability(
		db,
		[a],
		{ locationIds: [shelf], keep: null },
		{
			uncounted: UNLIMITED,
		},
	);
	expect(pushed.get(a)).toBe(UNLIMITED);
	// Everywhere else its number is still its ledger's.
	expect(
		(await getAvailability(db, [a], { locationIds: [shelf], keep: null })).get(
			a,
		),
	).toBe(0);
});

test("a set is limited only by its counted parts, and never blocked by the others", async () => {
	const free = await createProduct(db, "FREE", "simple");
	const kept = await createProduct(db, "KEPT", "simple");
	const set = await createProduct(db, "SET", "bundle");
	const allFree = await createProduct(db, "ALLFREE", "bundle");
	await setRecipe(db, set, [
		{ productId: free, quantity: 2 },
		{ productId: kept, quantity: 1 },
	]);
	await setRecipe(db, allFree, [{ productId: free, quantity: 3 }]);
	await postMovements(db, {
		lines: [
			{ productId: kept, locationId: shelf, delta: 4, reason: "receipt" },
		],
	});
	await markNotCounted(db, [free]);
	const pushed = await getAvailability(
		db,
		[set, allFree],
		{ locationIds: [shelf], keep: null },
		{
			uncounted: UNLIMITED,
		},
	);
	expect(pushed.get(set)).toBe(4);
	expect(pushed.get(allFree)).toBe(UNLIMITED);
	expect(
		await getBundleBlockers(db, { locationIds: [shelf], keep: null }),
	).toEqual([]);
});

test("a counted part with exactly the limit on hand still divides", async () => {
	const part = await createProduct(db, "PART", "simple");
	const set = await createProduct(db, "SET", "bundle");
	await setRecipe(db, set, [{ productId: part, quantity: 3 }]);
	await postMovements(db, {
		lines: [
			{
				productId: part,
				locationId: shelf,
				delta: UNLIMITED,
				reason: "receipt",
			},
		],
	});
	const pushed = await getAvailability(
		db,
		[set],
		{ locationIds: [shelf], keep: null },
		{
			uncounted: UNLIMITED,
		},
	);
	expect(pushed.get(set)).toBe(UNLIMITED / 3);
});

test("joins the count list, and a count ends it for good, even one that matches", async () => {
	const a = await createProduct(db, "A", "simple");
	await markNotCounted(db, [a]);
	const [level] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, a));
	expect(level.countRequestedAt).not.toBeNull();
	await recordCount(db, {
		productId: a,
		locationId: shelf,
		counted: 0,
		note: "",
	});
	expect(await notCounted(a)).toBe(false);
	// Marking again is a fresh decision, not something a count undoes.
	expect(await markNotCounted(db, [a])).toBe(1);
	expect(await markNotCounted(db, [a])).toBe(0);
});

test("a tool set can't be marked; its parts carry it", async () => {
	const set = await createProduct(db, "SET", "bundle");
	await expect(markNotCounted(db, [set])).rejects.toThrow(/mark their parts/);
	await expect(
		db
			.update(schema.products)
			.set({ notCountedSince: new Date() })
			.where(eq(schema.products.id, set)),
	).rejects.toThrow();
});
