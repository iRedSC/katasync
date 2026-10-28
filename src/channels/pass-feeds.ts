import type { Db } from "#/db/client";
import type { SyncedChannel } from "#/diagnostics/checks";
import type { Feed, FeedOutcome } from "#/diagnostics/feed-health";
import { recordQuietly } from "#/diagnostics/feed-record";
import { errorText } from "#/diagnostics/runs";
import type { StorePush } from "#/stock-push/push";

// A sync pass finds problems of three kinds, and each belongs to one feed:
// orders (reading and ingesting them), listings (matching them to products),
// stock (setting quantities). Kept apart so a stock complaint can't keep the
// orders feed from being green. Server only.

export type PassFeeds = {
	orders: string[];
	// Null when the pass didn't read listings.
	listings: string[] | null;
	stock: string[];
	pushed: StorePush[];
	// What retiring sold-out refurbs (src/orders/refurb-retire.ts) couldn't
	// do: Shopify's work, whichever channel's pass did it.
	retired: string[];
};

// Runs the part of a pass that reads one feed; if it throws, that feed
// failed, not orders.
export type FeedPhase = <T>(work: () => Promise<T>) => Promise<T>;

// The phases a pass may run, each recorded as its own feed's failure.
// listings is null when the pass shouldn't read them.
export type PassPhases = { listings: FeedPhase | null; stock: FeedPhase };

// Runs a pass and records its feeds: each phase that throws fails its own
// feed, anything else the pass throws fails orders; a pass that finished
// records them all. What the pass threw is thrown again.
export async function readingPassFeeds<T extends { feeds: PassFeeds }>(
	db: Db,
	channel: SyncedChannel,
	options: { listings: boolean },
	pass: (phases: PassPhases, startedAt: Date) => Promise<T>,
): Promise<T> {
	const startedAt = new Date();
	const failed = (feed: Feed, error: unknown) =>
		recordQuietly(db, channel, feed, startedAt, {
			kind: "failed",
			error: errorText(error),
		});
	// What a phase threw, already recorded as its feed's failure.
	const recorded = new Set<unknown>();
	const phase =
		(feed: Feed): FeedPhase =>
		async (work) => {
			try {
				return await work();
			} catch (error) {
				if (!recorded.has(error)) {
					recorded.add(error);
					await failed(feed, error);
				}
				throw error;
			}
		};
	let result: T;
	try {
		result = await pass(
			{
				listings: options.listings ? phase("listings") : null,
				stock: phase("stock"),
			},
			startedAt,
		);
	} catch (error) {
		if (!recorded.has(error)) await failed("orders", error);
		throw error;
	}
	await recordQuietly(
		db,
		channel,
		"orders",
		startedAt,
		ordersOutcome(result.feeds),
	);
	await recordSideFeeds(db, channel, startedAt, result.feeds);
	return result;
}

export const ordersOutcome = (f: PassFeeds): FeedOutcome => ({
	kind: "read",
	problems: f.orders,
});

// Records the listings and stock feeds of a pass that finished. Listings are
// read only by a pass that asked for them; stock only where a store pushes,
// since a channel pushing nothing has no stock feed to be fine or not.
// Retiring refurbs is Shopify's stock, so Shopify's own pass always records
// it, pushing or not. Another channel's pass leaves Shopify's feed alone: it
// would overwrite what Shopify's push found, and Shopify's next pass tries
// the same refurbs again and records how that went.
export async function recordSideFeeds(
	db: Db,
	channel: SyncedChannel,
	startedAt: Date,
	f: PassFeeds,
) {
	if (f.listings)
		await recordQuietly(db, channel, "listings", startedAt, {
			kind: "read",
			problems: f.listings,
		});
	const retiring = channel === "shopify";
	if (f.pushed.length > 0 || retiring)
		await recordQuietly(db, channel, "stock", startedAt, {
			kind: "read",
			problems: [...f.stock, ...(retiring ? f.retired : [])],
			excluded: f.pushed.reduce((n, p) => n + p.excluded, 0),
		});
}
