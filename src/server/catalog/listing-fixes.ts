import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import {
	deleteListings,
	relinkListings,
	unlinkListings,
} from "#/channels/listing-edits";
import { getDb } from "#/db/client";

// Fixing a listing already matched, from its product's page. The same core
// functions as Claude's tools (src/channels/listing-edits.ts), one listing at
// a time.

const listing = { listingId: "number.integer > 0" } as const;

// Says what the listing sells now: a product its SKU names, a new product
// the next sync makes, or nothing until someone matches it.
export const unlinkListing = createServerFn({ method: "POST" })
	.validator(type(listing))
	.handler(async ({ data }) => {
		const { listings, problems } = await unlinkListings(getDb(), [
			data.listingId,
		]);
		return { now: listings[0].now, problems };
	});

export const relinkListing = createServerFn({ method: "POST" })
	.validator(type({ ...listing, sku: "string > 0" }))
	.handler(async ({ data }) => {
		const [moved] = await relinkListings(getDb(), [data.listingId], data.sku);
		return moved;
	});

// Only one gone from its channel that never sold; anything else is refused,
// saying why.
export const deleteListing = createServerFn({ method: "POST" })
	.validator(type(listing))
	.handler(async ({ data }) => {
		await deleteListings(getDb(), [data.listingId]);
	});
