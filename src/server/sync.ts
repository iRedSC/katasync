import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { type SyncedNow, syncAllChannels } from "#/channels/sync-now";
import { getDb } from "#/db/client";

export type { SyncedNow };

// How often a channel syncs while the orders page asks, however many pages
// are open. The page asks every two minutes, so one page's asks always sync.
const WATCHED_FRESH_FOR_MS = 90_000;

// The orders page asks this when it opens and every couple of minutes while
// someone is using it, and Diagnostics when it opens (LiveSync), so orders
// arrive and health is current without the crons running often.
// `now` (the Sync button) skips the freshness check. Unconnected channels are
// left out; Diagnostics says why. Also makes any tracking retries now due.
export const syncChannels = createServerFn({ method: "POST" })
	.validator(type({ now: "boolean" }))
	.handler(({ data }) =>
		syncAllChannels(getDb(), data.now ? 0 : WATCHED_FRESH_FOR_MS),
	);
