import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { mirrorFbaStock, parseListingsReport } from "./amazon-listings";
import { ebayListingsPage } from "./ebay";
import { mapListing, syncListings } from "./listings";

test("eBay listings are keyed as order lines name them", () => {
	const page = ebayListingsPage(`<?xml version='1.0' encoding='UTF-8'?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
	<Ack>Success</Ack>
	<ActiveList>
		<ItemArray>
			<Item><ItemID>1</ItemID><Title>Radius Sander </Title><SKU>FCI-Rad360</SKU></Item>
			<Item><ItemID>2</ItemID><Title>No SKU</Title></Item>
			<Item><ItemID>3</ItemID><Title>Discs</Title><SKU>PARENT</SKU>
				<Variations>
					<Variation><SKU>0080</SKU><VariationTitle>Discs[80]</VariationTitle></Variation>
					<Variation><SKU>0100</SKU><VariationTitle>Discs[100]</VariationTitle></Variation>
				</Variations>
			</Item>
		</ItemArray>
		<PaginationResult><TotalNumberOfPages>2</TotalNumberOfPages></PaginationResult>
	</ActiveList>
</GetMyeBaySellingResponse>`);

	expect(page.pages).toBe(2);
	expect(page.listings).toEqual([
		{
			externalId: "FCI-Rad360",
			externalSku: "FCI-Rad360",
			title: "Radius Sander",
			fulfillment: "merchant",
		},
		{
			externalId: "2",
			externalSku: null,
			title: "No SKU",
			fulfillment: "merchant",
		},
		{
			externalId: "0080",
			externalSku: "0080",
			title: "Discs[80]",
			fulfillment: "merchant",
		},
		{
			externalId: "0100",
			externalSku: "0100",
			title: "Discs[100]",
			fulfillment: "merchant",
		},
	]);
});

test("an eBay failure says why", () => {
	expect(() =>
		ebayListingsPage(
			`<GetMyeBaySellingResponse><Ack>Failure</Ack><Errors><LongMessage>Token expired</LongMessage></Errors></GetMyeBaySellingResponse>`,
		),
	).toThrow("Token expired");
});

test("Amazon's listings report marks what Amazon ships as FBA", () => {
	const listings = parseListingsReport(
		"﻿item-name\tseller-sku\tfulfillment-channel\tstatus\r\n" +
			"Flat Box Handle\t34DMFH\tDEFAULT\tActive\r\n" +
			"Tape Tool\tTT-10BK-AMZ\tAMAZON_NA\tInactive\r\n",
	);
	expect(listings).toEqual([
		{
			externalId: "34DMFH",
			externalSku: "34DMFH",
			title: "Flat Box Handle",
			fulfillment: "merchant",
			status: "Active",
		},
		{
			externalId: "TT-10BK-AMZ",
			externalSku: "TT-10BK-AMZ",
			title: "Tape Tool",
			fulfillment: "fba",
			status: "Inactive",
		},
	]);
});

let db: Db;
let storeId: number;

beforeEach(async () => {
	db = await createTestDb();
	await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" });
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "amazon", name: "Amazon US", stockFrom: new Date() })
		.returning();
});

async function fbaOnHand() {
	return db
		.select({ sku: schema.products.sku, onHand: schema.stockLevels.onHand })
		.from(schema.stockLevels)
		.innerJoin(
			schema.locations,
			eq(schema.locations.id, schema.stockLevels.locationId),
		)
		.innerJoin(
			schema.products,
			eq(schema.products.id, schema.stockLevels.productId),
		)
		.where(eq(schema.locations.kind, "fba"))
		.orderBy(schema.products.sku);
}

test("FBA stock mirrors what Amazon reports, at its own location", async () => {
	const tape = await createProduct(db, "TT-10BK", "simple");
	await createProduct(db, "HANDLE", "simple");
	await syncListings(db, storeId, [
		{
			externalId: "TT-10BK-AMZ",
			externalSku: "TT-10BK-AMZ",
			title: "Tape",
			fulfillment: "fba",
		},
		{
			externalId: "HANDLE",
			externalSku: "HANDLE",
			title: "Handle",
			fulfillment: "merchant",
		},
		{
			externalId: "LOOSE",
			externalSku: "LOOSE",
			title: "Loose",
			fulfillment: "fba",
		},
	]);
	const [tapeListing] = await db
		.select()
		.from(schema.listings)
		.where(eq(schema.listings.externalId, "TT-10BK-AMZ"));
	await mapListing(db, tapeListing.id, tape);

	const first = await mirrorFbaStock(
		db,
		storeId,
		new Map([
			["TT-10BK-AMZ", 7],
			["HANDLE", 3],
			["LOOSE", 2],
		]),
	);
	expect(first.problems).toEqual([
		"FBA stock of LOOSE isn't matched to a product",
	]);
	expect(await fbaOnHand()).toEqual([{ sku: "TT-10BK", onHand: 7 }]);

	// Unchanged means nothing posted; gone from Amazon's report means 0.
	expect(
		(await mirrorFbaStock(db, storeId, new Map([["TT-10BK-AMZ", 7]]))).changed,
	).toBe(0);
	await mirrorFbaStock(db, storeId, new Map());
	expect(await fbaOnHand()).toEqual([{ sku: "TT-10BK", onHand: 0 }]);

	const [owned] = await db
		.select()
		.from(schema.ownedStock)
		.where(eq(schema.ownedStock.sku, "TT-10BK"));
	expect(owned.onHand).toBe(0);
});
