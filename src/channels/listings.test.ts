import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	autoMapListings,
	type ChannelListing,
	getListingsForProducts,
	getUnmappedListings,
	mapListing,
	syncListings,
} from "./listings";

let db: Db;
let shopify: number;
let amazon: number;

function listing(
	externalId: string,
	extra: Partial<ChannelListing> = {},
): ChannelListing {
	return {
		externalId,
		externalSku: externalId,
		title: externalId,
		fulfillment: "merchant",
		...extra,
	};
}

async function getListing(storeId: number, externalId: string) {
	const rows = await db
		.select()
		.from(schema.listings)
		.where(eq(schema.listings.externalId, externalId));
	const row = rows.find((r) => r.storeId === storeId);
	if (!row) throw new Error(`No listing ${externalId}`);
	return row;
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: shopify }, { id: amazon }] = await db
		.insert(schema.stores)
		.values([
			{ channel: "shopify", name: "Shopify" },
			{ channel: "amazon", name: "Amazon US" },
		])
		.returning();
});

describe("syncListings", () => {
	test("updates details on resync without losing the mapping", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await syncListings(db, shopify, [listing("111", { title: "Old title" })]);
		const { id } = await getListing(shopify, "111");
		await mapListing(db, id, wrench);

		await syncListings(db, shopify, [listing("111", { title: "New title" })]);
		const after = await getListing(shopify, "111");
		expect(after.title).toBe("New title");
		expect(after.productId).toBe(wrench);
	});

	test("only Amazon listings can be FBA", async () => {
		await expect(
			syncListings(db, shopify, [listing("111", { fulfillment: "fba" })]),
		).rejects.toThrow(/Only Amazon/);
	});

	test("unmaps a listing that became FBA while selling a bundle", async () => {
		const set = await createProduct(db, "SET", "bundle");
		await syncListings(db, amazon, [listing("SET")]);
		const { id } = await getListing(amazon, "SET");
		await mapListing(db, id, set);

		const { unmapped } = await syncListings(db, amazon, [
			listing("SET", { fulfillment: "fba" }),
		]);
		expect(unmapped).toEqual([id]);
		expect((await getListing(amazon, "SET")).productId).toBeNull();
	});
});

describe("mapListing", () => {
	test("rejects mapping an FBA listing to a bundle", async () => {
		const set = await createProduct(db, "SET", "bundle");
		await syncListings(db, amazon, [listing("SET", { fulfillment: "fba" })]);
		const { id } = await getListing(amazon, "SET");
		await expect(mapListing(db, id, set)).rejects.toThrow(/physical units/);
	});
});

describe("autoMapListings", () => {
	test("maps exact SKU matches and leaves the rest for a person", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await syncListings(db, shopify, [
			listing("1", { externalSku: "WRENCH" }),
			listing("2", { externalSku: "wrench" }),
		]);
		await syncListings(db, amazon, [
			listing("WRENCH"),
			listing("SET", { fulfillment: "fba" }),
			listing("NO-SKU", { externalSku: null }),
		]);

		expect(await autoMapListings(db)).toBe(2);
		expect((await getListing(shopify, "1")).productId).toBe(wrench);
		expect((await getListing(amazon, "WRENCH")).productId).toBe(wrench);
		expect((await getListing(amazon, "SET")).productId).toBeNull();

		const unmapped = await getUnmappedListings(db);
		expect(unmapped.map((l) => l.externalId).sort()).toEqual([
			"2",
			"NO-SKU",
			"SET",
		]);

		const forWrench = await getListingsForProducts(db, [wrench, set]);
		expect(forWrench.map((l) => l.channel).sort()).toEqual([
			"amazon",
			"shopify",
		]);
	});
});
