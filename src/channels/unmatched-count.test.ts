import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { syncListings } from "./listings";
import { countUnmatched, listUnmatched } from "./unmatched";

let db: Db;
let shopify: number;
let tiktok: number;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shopify }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	[{ id: tiktok }] = await db
		.insert(schema.stores)
		.values({ channel: "tiktok", name: "TikTok" })
		.returning();
});

const listing = (
	externalId: string,
	externalSku: string | null,
	title: string,
) => ({
	externalId,
	externalSku,
	title,
	fulfillment: "merchant" as const,
});

// The count is made in SQL and the groups in the app; they have to agree.
async function expectItems(count: number) {
	const items = await listUnmatched(db);
	expect(items).toHaveLength(count);
	expect(await countUnmatched(db)).toBe(count);
}

test("blank, spaced, and differently cased SKUs group as the item they name", async () => {
	await syncListings(db, shopify, [
		listing("a", "  ", "Rock Splicer"),
		listing("b", "", "Rock Splicer"),
		listing("c", " ab-1 ", "One"),
		listing("d", "AB-1", "Two"),
	]);
	await syncListings(db, tiktok, [
		listing("e", null, "rock splicer - Default Title"),
	]);
	// No SKU: one item by title across all three. The SKU pair is one item.
	await expectItems(2);
});

test("a SKU and a title never share a key, even when their text matches", async () => {
	await syncListings(db, shopify, [
		listing("f", null, "Rock Splicer"),
		listing("g", "title:rock splicer", "Other"),
		listing("h", "RS", "Rock Splicer"),
	]);
	await expectItems(3);
});

test("punctuation and spacing in a title don't split it when it has no SKU", async () => {
	await syncListings(db, shopify, [
		listing("i", null, "Rock-Splicer!"),
		listing("j", null, "rock splicer"),
		listing("k", null, "Rock Splicer "),
	]);
	await expectItems(1);
});
