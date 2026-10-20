import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { type WatchedPass, watchedPass } from "#/channels/sync";
import { getDb } from "#/db/client";
import {
	channelEnv,
	missingEnv,
	type SyncedChannel,
} from "#/diagnostics/checks";
import { errorText } from "#/diagnostics/runs";
import { retryDueTracking } from "#/shipping/retry";

// How often a channel syncs while the orders page asks, however many pages
// are open. The page asks every two minutes, so one page's asks always sync.
const WATCHED_FRESH_FOR_MS = 90_000;

export type SyncedNow = { channel: SyncedChannel } & (
	| WatchedPass
	| { state: "failed"; error: string }
);

// The orders page asks this when it opens and every couple of minutes while
// someone is using it, and Diagnostics when it opens (LiveSync), so orders
// arrive and health is current without the crons running often.
// `now` (the Sync button) skips the freshness check. Unconnected channels are
// left out; Diagnostics says why. Also makes any tracking retries now due.
export const syncChannels = createServerFn({ method: "POST" })
	.validator(type({ now: "boolean" }))
	.handler(async ({ data }): Promise<SyncedNow[]> => {
		const db = getDb();
		const channels = (Object.keys(channelEnv) as SyncedChannel[]).filter(
			(c) => missingEnv(channelEnv[c]).length === 0,
		);
		const passes = await Promise.all(
			channels.map(async (channel): Promise<SyncedNow> => {
				try {
					const pass = await watchedPass(
						db,
						channel,
						data.now ? 0 : WATCHED_FRESH_FOR_MS,
					);
					return { channel, ...pass };
				} catch (error) {
					return { channel, state: "failed", error: errorText(error) };
				}
			}),
		);
		await retryDueTracking(db).catch((error) =>
			console.error("Tracking retries from the orders page:", error),
		);
		return passes;
	});
