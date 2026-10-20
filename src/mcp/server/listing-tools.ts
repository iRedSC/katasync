import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { relinkListings, unlinkListings } from "#/channels/listing-edits";
import type { Db } from "#/db/client";
import { json, WRITE } from "./tool-shapes";

// Changing listings already matched. match_listing (catalog-tools) handles
// unmatched ones.
export function registerListingTools(server: McpServer, db: Db) {
	const listingIds = z
		.array(z.number().int().positive())
		.min(1)
		.describe("listings.id");

	server.registerTool(
		"unlink_listings",
		{
			description:
				"Unmatches listings from their products, all or none, then matches them by SKU as a sync would; returns what each sells now (matched, new_product_next_sync, or unmatched). Refused when a listing's SKU would match it straight back to the same product. Past orders keep the stock they took. To move a listing to the right product, use relink_listings instead.",
			inputSchema: { listing_ids: listingIds },
			annotations: WRITE,
		},
		async ({ listing_ids }) => json(await unlinkListings(db, listing_ids)),
	);

	server.registerTool(
		"relink_listings",
		{
			description:
				"Moves matched listings to the product with sku, all or none, e.g. one matched to the wrong product. Later sales take the new product's stock; past orders keep what they took.",
			inputSchema: { listing_ids: listingIds, sku: z.string() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ listing_ids, sku }) =>
			json(await relinkListings(db, listing_ids, sku)),
	);
}
