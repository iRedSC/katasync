import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { relinkListings, unlinkListings } from "./listing-edits";
import { mapListing, syncListings } from "./listings";

let db: Db;
let shopify: number;
let tiktok: number;
let wrench: number;

async function listed(storeId: number, externalSku: string | null) {
	const externalId = `${storeId}-${externalSku}`;
	await syncListings(db, storeId, [
		{
			externalId,
			externalSku,
			title: `Sells ${externalSku}`,
			fulfillment: "merchant",
		},
	]);
	const [row] = await db
		.select()
		.from(schema.listings)
		.where(eq(schema.listings.externalId, externalId));
	return row.id;
}

const productOf = async (id: number) =>
	(
		await db
			.select({ productId: schema.listings.productId })
			.from(schema.listings)
			.where(eq(schema.listings.id, id))
	)[0].productId;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shopify }, { id: tiktok }] = await db
		.insert(schema.stores)
		.values([
			{ channel: "shopify", name: "Shopify", primary: true },
			{ channel: "tiktok", name: "TikTok" },
		])
		.returning();
	wrench = await createProduct(db, "WRENCH", "simple");
});

describe("unlinkListings", () => {
	test("refuses when the SKU would match it straight back", async () => {
		const id = await listed(tiktok, "WRENCH");
		await mapListing(db, id, wrench);
		await expect(unlinkListings(db, [id])).rejects.toThrow(/straight back/);
		expect(await productOf(id)).toBe(wrench);
	});

	test("says what each listing sells now", async () => {
		const hammer = await createProduct(db, "HAMMER", "simple");
		const bySku = await listed(tiktok, "HAMMER");
		const custom = await listed(tiktok, null);
		const fresh = await listed(shopify, "NEW-ONE");
		for (const id of [bySku, custom, fresh]) await mapListing(db, id, wrench);

		const { listings } = await unlinkListings(db, [bySku, custom, fresh]);
		expect(listings.map((l) => l.now)).toEqual([
			{ kind: "matched", sku: "HAMMER" },
			{ kind: "unmatched" },
			{ kind: "new_product_next_sync", sku: "NEW-ONE" },
		]);
		expect(await productOf(bySku)).toBe(hammer);
		expect(await productOf(custom)).toBeNull();
	});

	test("all or none, and only matched listings", async () => {
		const loose = await listed(tiktok, null);
		const matched = await listed(tiktok, "OTHER");
		await mapListing(db, matched, wrench);
		await expect(unlinkListings(db, [matched, loose])).rejects.toThrow(
			/Not matched/,
		);
		expect(await productOf(matched)).toBe(wrench);
	});
});

test("relinkListings moves matched listings to another product", async () => {
	const hammer = await createProduct(db, "HAMMER", "simple");
	const id = await listed(tiktok, "WRENCH");
	await mapListing(db, id, wrench);
	expect(await relinkListings(db, [id], "HAMMER")).toMatchObject([
		{ was: "WRENCH", now: "HAMMER" },
	]);
	expect(await productOf(id)).toBe(hammer);
	await expect(relinkListings(db, [id], "NOPE")).rejects.toThrow(/No product/);
});
