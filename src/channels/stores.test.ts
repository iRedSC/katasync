import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { ensureStore } from "./stores";

let db: Db;

beforeEach(async () => {
	db = await createTestDb();
});

const SHOP = "gid://shopify/Shop/1";

test("renaming the shop renames its store instead of adding one", async () => {
	const first = await ensureStore(db, "shopify", {
		id: SHOP,
		name: "Acme Inc.",
	});
	const renamed = await ensureStore(db, "shopify", { id: SHOP, name: "Acme" });
	expect(renamed.id).toBe(first.id);
	expect(renamed.name).toBe("Acme");
	expect(await db.select().from(schema.stores)).toHaveLength(1);
});

test("a store from before account IDs is claimed by name, then follows renames", async () => {
	const [old] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Acme Inc." })
		.returning();
	const claimed = await ensureStore(db, "shopify", {
		id: SHOP,
		name: "Acme Inc.",
	});
	expect(claimed.id).toBe(old.id);
	expect(claimed.accountId).toBe(SHOP);
	const renamed = await ensureStore(db, "shopify", { id: SHOP, name: "Acme" });
	expect(renamed.id).toBe(old.id);
});

test("a second account on the channel is its own store", async () => {
	const a = await ensureStore(db, "shopify", { id: SHOP, name: "Acme" });
	const b = await ensureStore(db, "shopify", {
		id: "gid://shopify/Shop/2",
		name: "Other",
	});
	expect(b.id).not.toBe(a.id);
});
