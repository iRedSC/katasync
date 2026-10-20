import type { Db } from "#/db/client";
import {
	channelEnv,
	missingEnv,
	type SyncedChannel,
} from "#/diagnostics/checks";
import { errorText } from "#/diagnostics/runs";
import { retryDueTracking } from "#/shipping/retry";
import { type WatchedPass, watchedPass } from "./sync";

export type SyncedNow = { channel: SyncedChannel } & (
	| WatchedPass
	| { state: "failed"; error: string }
);

// Syncs every connected channel that hasn't synced in `freshForMs` (0 for
// all of them now), then makes any tracking retries now due. Unconnected
// channels are left out; Diagnostics says why. One channel failing doesn't
// stop the others.
export async function syncAllChannels(
	db: Db,
	freshForMs: number,
): Promise<SyncedNow[]> {
	const channels = (Object.keys(channelEnv) as SyncedChannel[]).filter(
		(c) => missingEnv(channelEnv[c]).length === 0,
	);
	const passes = await Promise.all(
		channels.map(async (channel): Promise<SyncedNow> => {
			try {
				const pass = await watchedPass(db, channel, freshForMs);
				return { channel, ...pass };
			} catch (error) {
				return { channel, state: "failed", error: errorText(error) };
			}
		}),
	);
	await retryDueTracking(db).catch((error) =>
		console.error("Tracking retries after a sync:", error),
	);
	return passes;
}
