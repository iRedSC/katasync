import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { matchListings } from "#/channels/listings";
import { stockLocations } from "#/channels/stores";
import { isSyncedChannel, syncPassAlone } from "#/channels/sync";
import { listUnmatched } from "#/channels/unmatched";
import { getDb } from "#/db/client";
import { stores } from "#/db/schema";
import { channelEnv, missingEnv } from "#/diagnostics/checks";
import { errorText } from "#/diagnostics/runs";
import {
	applyListingsToOrders,
	matchListing as matchListingToSku,
	productFromListing,
} from "#/orders/remap";

// Makes one store the primary (or none, with id null), then lets its
// unmatched listings become products right away instead of on the next sync.
export const setPrimaryStore = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0 | null" }))
	.handler(async ({ data }) => {
		const db = getDb();
		await db.transaction(async (tx) => {
			await tx
				.update(stores)
				.set({ primary: false })
				.where(eq(stores.primary, true));
			if (data.id) {
				await tx
					.update(stores)
					.set({ primary: true })
					.where(eq(stores.id, data.id));
			}
		});
		if (!data.id) return { created: 0, skipped: [] as string[] };
		const matched = await matchListings(db);
		await applyListingsToOrders(db, matched.mapped, await stockLocations(db));
		return { created: matched.created, skipped: matched.skipped };
	});

export type PulledPrimary =
	| { state: "ran"; store: string; created: number; problems: string[] }
	// Another pass or a webhook held the channel for 30s.
	| { state: "busy"; store: string }
	| { state: "failed"; store: string; error: string };

// A full pass of the primary store's channel now, listings included, so its
// new SKUs become products without waiting for the four-hourly cron.
export const pullPrimaryNow = createServerFn({ method: "POST" }).handler(
	async (): Promise<PulledPrimary> => {
		const db = getDb();
		const [store] = await db
			.select()
			.from(stores)
			.where(eq(stores.primary, true));
		if (!store) throw new Error("No primary store to pull from");
		const channel = store.channel;
		if (!isSyncedChannel(channel))
			throw new Error(`${store.name} isn't a channel katasync syncs`);
		const missing = missingEnv(channelEnv[channel]);
		if (missing.length > 0)
			return {
				state: "failed",
				store: store.name,
				error: `Set ${missing.join(", ")}`,
			};
		try {
			const result = await syncPassAlone(db, channel, { listings: true });
			if (!result) return { state: "busy", store: store.name };
			return {
				state: "ran",
				store: store.name,
				created: result.created,
				problems: result.problems,
			};
		} catch (error) {
			return { state: "failed", store: store.name, error: errorText(error) };
		}
	},
);

// Listings without a SKU are custom products and never need one.
// Things channels sell that no product backs, with each one's likely
// products. With an order, only what that order sold.
export const listUnmatchedItems = createServerFn({ method: "GET" })
	.validator(type({ "orderId?": "number.integer > 0" }))
	.handler(async ({ data }) => listUnmatched(getDb(), data));

const item = type({ listingIds: "(number.integer > 0)[] > 0" });

// Matches every listing of an unmatched item to a product, then catches up
// past orders.
export const matchListing = createServerFn({ method: "POST" })
	.validator(item.and({ sku: "string > 0" }))
	.handler(async ({ data }) =>
		matchListingToSku(getDb(), data.listingIds, data.sku),
	);

// Creates the product a listing is selling, filled in from the listing.
export const createListingProduct = createServerFn({ method: "POST" })
	.validator(item.and({ "sku?": "string > 0", "name?": "string > 0" }))
	.handler(async ({ data }) =>
		productFromListing(getDb(), data.listingIds, data),
	);
