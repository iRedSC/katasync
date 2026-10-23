import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	deleteListings,
	relinkListings,
	unlinkListings,
} from "#/channels/listing-edits";
import { setPrimaryStore } from "#/channels/primary-store";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
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

	server.registerTool(
		"delete_listings",
		{
			description:
				"Deletes listings gone from their channel (listings.gone_at is set: a full sync stopped reporting them) that never sold, all or none. Refused, saying why, for any still on the channel (the next sync would bring it back) or that sold. Can't be undone. Ask the user first.",
			inputSchema: { listing_ids: listingIds },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ listing_ids }) => json(await deleteListings(db, listing_ids)),
	);

	server.registerTool(
		"set_primary_store",
		{
			description:
				"Which store's listings become products: its new listings are made products on each sync, and its unmatched ones right away. By store name (see the stores table); null for none, so new listings wait to be matched. Returns how many products it made and listings it skipped.",
			inputSchema: { store: z.string().nullable() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ store }) => {
			let id: number | null = null;
			if (store !== null) {
				const [found] = await db
					.select({ id: stores.id })
					.from(stores)
					.where(eq(stores.name, store));
				if (!found) throw new Error(`No store called ${store}`);
				id = found.id;
			}
			return json({ primary: store, ...(await setPrimaryStore(db, id)) });
		},
	);
}
