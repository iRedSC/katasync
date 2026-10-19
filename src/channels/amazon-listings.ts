import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { listings, locations, stockLevels } from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { MARKETPLACE_US, spApi } from "./amazon-api";
import { latestReport } from "./amazon-reports";
import type { ChannelListing } from "./listings";

// Amazon's listings come from its "all listings" report (amazon-reports.ts).
// Needs the SP-API Product Listing role.
const REPORT = "GET_MERCHANT_LISTINGS_ALL_DATA";
// A report younger than this is current enough; listings refresh every 30
// minutes.
const FRESH_MS = 25 * 60 * 1000;

// Every listing on Amazon US, or null while the report is still being built.
export async function amazonListings(
	now = Date.now(),
): Promise<ChannelListing[] | null> {
	const text = await latestReport(REPORT, { freshMs: FRESH_MS, now });
	return text === null ? null : parseListingsReport(text);
}

// The report is tab-separated with a header row. A listing Amazon ships
// (fulfillment channel AMAZON_NA) is FBA.
export function parseListingsReport(text: string): ChannelListing[] {
	const [header, ...rows] = text.replace(/^﻿/, "").split(/\r?\n/);
	const columns = header.split("\t");
	const at = (name: string) => {
		const i = columns.indexOf(name);
		if (i < 0) throw new Error(`Amazon's listings report has no ${name}`);
		return i;
	};
	const sku = at("seller-sku");
	const name = at("item-name");
	const channel = at("fulfillment-channel");
	const status = at("status");
	return rows
		.map((row) => row.split("\t"))
		.filter((cells) => cells[sku]?.trim())
		.map((cells) => ({
			externalId: cells[sku].trim(),
			externalSku: cells[sku].trim(),
			title: cells[name]?.trim() ?? "",
			fulfillment: cells[channel]?.startsWith("AMAZON")
				? ("fba" as const)
				: ("merchant" as const),
			status: cells[status]?.trim() || null,
		}));
}

const inventoryPage = type({
	payload: {
		inventorySummaries: type({
			sellerSku: "string",
			"inventoryDetails?": { "fulfillableQuantity?": "number.integer" },
		}).array(),
	},
	"pagination?": { "nextToken?": "string" },
});

// What Amazon can sell from its warehouses right now, per seller SKU.
// Needs the SP-API Amazon Fulfillment role.
export async function fbaQuantities(): Promise<Map<string, number>> {
	const quantities = new Map<string, number>();
	let nextToken: string | undefined;
	do {
		const page = inventoryPage.assert(
			await spApi(
				`/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${MARKETPLACE_US}&marketplaceIds=${MARKETPLACE_US}${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ""}`,
			),
		);
		for (const s of page.payload.inventorySummaries)
			quantities.set(
				s.sellerSku,
				(quantities.get(s.sellerSku) ?? 0) +
					(s.inventoryDetails?.fulfillableQuantity ?? 0),
			);
		nextToken = page.pagination?.nextToken;
	} while (nextToken);
	return quantities;
}

const FBA_LOCATION = "Amazon FBA";

// Sets each product's stock at the FBA location to what Amazon reports for
// the FBA listings mapped to it, as one ledger batch. It's Amazon's stock, so
// it never counts as ours (owned_stock leaves it out) and no sale takes from
// it. A product Amazon no longer reports goes to 0. FBA listings not matched
// to a product come back as problems.
export async function mirrorFbaStock(
	db: Db,
	storeId: number,
	quantities: Map<string, number>,
): Promise<{ changed: number; problems: string[] }> {
	const locationId = await fbaLocation(db);
	const mapped = await db
		.select({ sku: listings.externalId, productId: listings.productId })
		.from(listings)
		.where(and(eq(listings.storeId, storeId), eq(listings.fulfillment, "fba")));
	const productOf = new Map(mapped.map((l) => [l.sku, l.productId]));

	const want = new Map<number, number>();
	const problems: string[] = [];
	for (const [sku, quantity] of quantities) {
		const productId = productOf.get(sku);
		if (productId === undefined) continue; // Not an FBA listing (any more).
		if (productId === null) {
			if (quantity > 0)
				problems.push(`FBA stock of ${sku} isn't matched to a product`);
			continue;
		}
		want.set(productId, (want.get(productId) ?? 0) + quantity);
	}

	const held = await db
		.select({ productId: stockLevels.productId, onHand: stockLevels.onHand })
		.from(stockLevels)
		.where(eq(stockLevels.locationId, locationId));
	for (const { productId } of held)
		if (!want.has(productId)) want.set(productId, 0);
	const now = new Map(held.map((h) => [h.productId, h.onHand]));
	const lines = [...want]
		.map(([productId, quantity]) => ({
			productId,
			locationId,
			delta: quantity - (now.get(productId) ?? 0),
			reason: "adjustment" as const,
		}))
		.filter((l) => l.delta !== 0);
	if (lines.length > 0)
		await postMovements(db, {
			lines,
			reference: FBA_LOCATION,
			note: "What Amazon reports",
		});
	return { changed: lines.length, problems };
}

async function fbaLocation(db: Db) {
	const [found] = await db
		.select({ id: locations.id, kind: locations.kind })
		.from(locations)
		.where(eq(locations.name, FBA_LOCATION));
	if (found) {
		if (found.kind !== "fba")
			throw new Error(`${FBA_LOCATION} is one of our own locations`);
		return found.id;
	}
	const [created] = await db
		.insert(locations)
		.values({ name: FBA_LOCATION, kind: "fba" })
		.onConflictDoNothing()
		.returning({ id: locations.id });
	if (created) return created.id;
	return fbaLocation(db);
}
