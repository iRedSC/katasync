import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	autoMapListings,
	type ChannelListing,
	createProductFromListing,
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
	test("maps SKU matches and leaves the rest for a person", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await syncListings(db, shopify, [
			listing("1", { externalSku: "WRENCH" }),
			listing("2", { externalSku: "wrench" }),
			listing("3", { externalSku: "NOT-IN-CATALOG" }),
		]);
		await syncListings(db, amazon, [
			listing("WRENCH"),
			listing("SET", { fulfillment: "fba" }),
			listing("NO-SKU", { externalSku: null }),
		]);

		expect(await autoMapListings(db)).toHaveLength(3);
		expect((await getListing(shopify, "1")).productId).toBe(wrench);
		// Different capitals, but only one product it could be.
		expect((await getListing(shopify, "2")).productId).toBe(wrench);
		expect((await getListing(amazon, "WRENCH")).productId).toBe(wrench);
		expect((await getListing(amazon, "SET")).productId).toBeNull();

		const unmapped = await getUnmappedListings(db);
		expect(unmapped.map((l) => l.externalId).sort()).toEqual(["3", "SET"]);

		const forWrench = await getListingsForProducts(db, [wrench, set]);
		expect(forWrench.map((l) => l.channel).sort()).toEqual([
			"amazon",
			"shopify",
			"shopify",
		]);
	});
});

describe("matching by SKU in different capitals", () => {
	test("maps when exactly one product matches, ignoring case and spaces", async () => {
		const spring = await createProduct(db, "TT-052576", "simple");
		await syncListings(db, shopify, [
			listing("1", { externalSku: " tt-052576 " }),
		]);
		expect(await autoMapListings(db)).toHaveLength(1);
		expect((await getListing(shopify, "1")).productId).toBe(spring);
	});

	test("leaves it for a person when two products would match", async () => {
		await createProduct(db, "AB-1", "simple");
		await createProduct(db, "ab-1", "simple");
		await syncListings(db, shopify, [listing("1", { externalSku: "Ab-1" })]);
		expect(await autoMapListings(db)).toHaveLength(0);
	});
});

describe("createProductFromListing", () => {
	test("fills the product in from the listing and maps it", async () => {
		await syncListings(db, shopify, [
			listing("1", {
				externalSku: "TPRO-FAN",
				title: "Tapepro Flat Applicator Nozzle - Default Title",
			}),
		]);
		const { id } = await getListing(shopify, "1");
		const product = await createProductFromListing(db, id);
		const [row] = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, product.id));
		expect(row).toMatchObject({
			sku: "TPRO-FAN",
			name: "Tapepro Flat Applicator Nozzle",
			kind: "simple",
		});
		expect((await getListing(shopify, "1")).productId).toBe(product.id);
	});

	test("refuses a SKU that already exists in other capitals", async () => {
		await createProduct(db, "TPRO-FAN", "simple");
		await syncListings(db, shopify, [
			listing("1", { externalSku: "tpro-fan" }),
		]);
		const { id } = await getListing(shopify, "1");
		await expect(createProductFromListing(db, id)).rejects.toThrow(
			/match the listing/,
		);
	});
});
