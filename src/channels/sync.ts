import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { syncRuns } from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import type { FeedOutcome } from "#/diagnostics/feed-health";
import { readingFeed } from "#/diagnostics/feed-record";
import { recordSyncRun } from "#/diagnostics/runs";
import {
	type PostedLister,
	refreshCosts,
	sweepPosted,
} from "#/orders/cost-refresh";
import { retireRefurbs } from "#/orders/refurb-retire";
import { applySkusToOrders } from "#/orders/remap";
import { assignOrderPins } from "#/shipping/pins";
import { stockChannels } from "#/stock-push/channels";
import { pushMoved } from "#/stock-push/on-change";
import { pushChannelStock, pushMode } from "#/stock-push/push";
import { syncAmazon } from "./amazon";
import { holdingChannel } from "./channel-lock";
import { syncEbay } from "./ebay";
import { amazonPostedSince, fetchAmazonCharges } from "./finance/amazon";
import { fetchEbayCharges } from "./finance/ebay";
import { fetchShopifyCharges } from "./finance/shopify";
import { fetchTiktokCharges } from "./finance/tiktok";
import type { OrderUpdate, WebhookUpdate } from "./order-update";
import {
	type FeedPhase,
	type PassFeeds,
	type PassPhases,
	readingPassFeeds,
} from "./pass-feeds";
import { returnsPass } from "./returns-pass";
import { ingestShopifyOrder, syncShopify } from "./shopify";
import { stockLocations } from "./stores";
import { ingestTiktokOrder, syncTiktok } from "./tiktok";

// One sync pass of a channel: pull its orders (and, with `listings`, its
// listings), catch up its lines that now have a product, set its stores'
// listing quantities where stock push is on (src/stock-push), record the run
// and its orders, listings, and stock feeds for Diagnostics (each gets only
// its own problems), then pin any new orders to ship.
// Returns have their own pass (returnsPassAlone).
// Shared by `pnpm sync` (scripts/sync.ts) and the Vercel crons
// (src/routes/api/cron/sync.$channel.ts). Server only.

const passes: Record<
	SyncedChannel,
	(
		db: Db,
		// Runs the listings part of the pass; null to skip it.
		listings: FeedPhase | null,
	) => Promise<{
		store: string;
		// Products made from the primary store's new SKUs (matchListings).
		created: number;
		orders: number;
		// Matching and mirroring listings; none without `listings`.
		listingProblems: string[];
		// Reading and ingesting orders.
		problems: string[];
	}>
> = {
	shopify: (db, listings) => syncShopify(db, { listings }),
	ebay: (db, listings) => syncEbay(db, { listings }),
	tiktok: (db, listings) => syncTiktok(db, { listings }),
	amazon: (db, listings) => syncAmazon(db, { listings }),
};

export const isSyncedChannel = (name: string): name is SyncedChannel =>
	Object.hasOwn(passes, name);

// Unlocked: callers outside this file go through syncPassAlone or
// watchedPass, so two passes of a channel never import the same orders at once.
async function syncPass(
	db: Db,
	channel: SyncedChannel,
	options: { listings: boolean },
) {
	const result = await readingPassFeeds(db, channel, options, (phases, at) =>
		ordersPass(db, channel, phases, at),
	);
	const pinned = await assignOrderPins(db);
	return { ...result, pinned };
}

function ordersPass(
	db: Db,
	channel: SyncedChannel,
	phases: PassPhases,
	started: Date,
) {
	return recordSyncRun(db, channel, async () => {
		const pass = await passes[channel](db, phases.listings);
		const caughtUp = await applySkusToOrders(
			db,
			{ channel },
			await stockLocations(db),
		);
		const pushed = await phases.stock(() =>
			pushChannelStock(db, channel, stockChannels[channel], pushMode()),
		);
		// This channel's sales reach the others now, not at their own passes.
		const elsewhere = await pushMoved(db, started, { except: channel });
		// A refurb this pass sold out is archived, here and in Shopify. What
		// fails is on Shopify's stock feed, whichever pass this is.
		const retired = await retireRefurbs(db);
		const feeds: PassFeeds = {
			orders: [...pass.problems, ...caughtUp.problems],
			listings: phases.listings ? pass.listingProblems : null,
			stock: pushed.flatMap((p) => p.problems),
			pushed,
			retired: retired.problems,
		};
		return {
			...pass,
			feeds,
			// The run keeps every problem; other channels' pushes show only here.
			problems: [
				...new Set([
					...feeds.orders,
					...(feeds.listings ?? []),
					...feeds.stock,
					...feeds.retired,
					...elsewhere.flatMap((p) => p.problems),
				]),
			],
		};
	});
}

// The same pass, unless another of this channel is already running anywhere:
// a slow pass would otherwise overlap the next cron and import the same orders
// twice at once. Waits briefly for a webhook's ingest to finish first, and
// queued like that it can't be cut in front of: Postgres grants no new lock,
// try-locks included, past a waiter. Returns null if the lock stays taken.
export async function syncPassAlone(
	db: Db,
	channel: SyncedChannel,
	options: { listings: boolean },
) {
	return holdingChannel(channel, { purpose: "sync-pass", waitFor: "30s" }, () =>
		syncPass(db, channel, options),
	);
}

// What a pass asked for by someone watching the orders page did. `at` is when
// the pass finished, so the page can show a time that's true.
export type WatchedPass =
	| { state: "ran"; at: Date; orders: number; problems: number }
	// Another pass or a webhook holds the channel; nothing finished for this ask.
	| { state: "busy" }
	// A pass finished within freshFor; another now would only repeat it.
	| { state: "fresh"; at: Date; problems: number }
	// The pass that finished within freshFor failed; it isn't retried until then.
	| { state: "failed"; error: string };

// A pass for the orders page, which asks every couple of minutes while it's
// open. However many pages are open, a channel syncs at most once per
// freshFor: the check happens under the channel's lock, so two pages asking at
// once can't both pass it. Listings are left to the crons.
export async function watchedPass(
	db: Db,
	channel: SyncedChannel,
	freshForMs: number,
): Promise<WatchedPass> {
	const outcome = await holdingChannel(
		channel,
		{ purpose: "sync-pass" },
		async (): Promise<WatchedPass> => {
			const since = new Date(Date.now() - freshForMs);
			const [recent] = await db
				.select({
					finishedAt: syncRuns.finishedAt,
					error: syncRuns.error,
					problems: syncRuns.problems,
				})
				.from(syncRuns)
				.where(
					and(
						eq(syncRuns.channel, channel),
						gte(syncRuns.startedAt, since),
						isNotNull(syncRuns.finishedAt),
					),
				)
				.orderBy(desc(syncRuns.startedAt))
				.limit(1);
			if (recent?.finishedAt) {
				if (recent.error) return { state: "failed", error: recent.error };
				return {
					state: "fresh",
					at: recent.finishedAt,
					problems: recent.problems,
				};
			}
			const result = await syncPass(db, channel, { listings: false });
			return {
				state: "ran",
				at: new Date(),
				orders: result.orders,
				problems: result.problems.length,
			};
		},
	);
	return outcome ?? { state: "busy" };
}

const chargeFetchers = {
	shopify: fetchShopifyCharges,
	ebay: fetchEbayCharges,
	tiktok: fetchTiktokCharges,
	amazon: fetchAmazonCharges,
};

// Marketplaces that can list what they posted lately, swept first each pass.
const postedListers: Partial<Record<SyncedChannel, PostedLister>> = {
	amazon: amazonPostedSince,
};

// Asks a marketplace again about what it charged on orders that are due
// (src/orders/cost-refresh.ts). It only writes charges, never orders, so it
// has a lock of its own and never waits on or holds up the order sync.
// Returns null if the last cost pass is still running.
//
// With keepGoingForMs, takes batch after batch until nothing is due or that
// long has passed: the crons run every few hours, so one batch per run would
// fall behind. A checked order isn't due again for an hour, failed or not, so
// the batches end.
export async function costPassAlone(
	db: Db,
	channel: SyncedChannel,
	options: { history?: boolean; limit?: number; keepGoingForMs?: number } = {},
) {
	// The history catch-up only takes orders past the regular passes' 60 days,
	// so it has a lock of its own: hours of old orders mustn't hold up new ones.
	const purpose = options.history ? "cost-history" : "cost-pass";
	const until = Date.now() + (options.keepGoingForMs ?? 0);
	const pass = async () => {
		const total = { checked: 0, reported: 0, problems: [] as string[] };
		const listPosted = postedListers[channel];
		if (listPosted && !options.history) {
			try {
				// Half the pass at most, so the regular batches still get a turn.
				const swept = await sweepPosted(
					db,
					channel,
					chargeFetchers[channel],
					listPosted,
					{ until: Date.now() + (options.keepGoingForMs ?? 0) / 2 },
				);
				total.checked += swept.checked;
				total.reported += swept.reported;
				total.problems.push(...swept.problems);
			} catch (e) {
				// The regular batches still run.
				total.problems.push(
					`Listing what ${channel} posted failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
		for (;;) {
			const batch = await refreshCosts(
				db,
				channel,
				chargeFetchers[channel],
				options,
			);
			total.checked += batch.checked;
			total.reported += batch.reported;
			total.problems.push(...batch.problems);
			// A batch where every order failed is likely an outage or a login;
			// more batches would only fail the same way.
			const allFailed = batch.problems.length >= batch.checked;
			if (batch.checked === 0 || allFailed || Date.now() >= until) return total;
		}
	};
	// The history catch-up reads orders no regular pass would; it isn't the
	// charges feed.
	return holdingChannel(channel, { purpose }, () =>
		options.history
			? pass()
			: readingFeed(db, channel, "charges", pass, chargesOutcome),
	);
}

// Every order failing is likely an outage or a login, not single orders.
function chargesOutcome(total: {
	checked: number;
	problems: string[];
}): FeedOutcome {
	if (total.checked > 0 && total.problems.length >= total.checked)
		return { kind: "failed", error: total.problems[0] };
	return { kind: "read", problems: total.problems };
}

// One returns pass of the channel (returns-pass.ts), unless the last one is
// still running. Returns null if it is. It writes returns, never orders, so
// it doesn't wait on the order sync.
export async function returnsPassAlone(db: Db, channel: SyncedChannel) {
	return holdingChannel(channel, { purpose: "returns-pass" }, () =>
		returnsPass(db, channel),
	);
}

const ingestOne: Partial<
	Record<SyncedChannel, (db: Db, orderId: string) => Promise<OrderUpdate>>
> = {
	shopify: ingestShopifyOrder,
	tiktok: ingestTiktokOrder,
};

// One order a webhook named, then pins for it if it's new. Gives up at once if
// a pass or another webhook holds the channel: waiting would hold a connection
// per webhook, and a burst of them (a bulk edit in Shopify) would drain the
// pool the lock holder needs. Busy and incomplete work stays in the inbox.
export async function ingestWebhookOrder(
	db: Db,
	channel: SyncedChannel,
	orderId: string,
): Promise<WebhookUpdate> {
	const ingest = ingestOne[channel];
	if (!ingest) throw new Error(`${channel} has no webhooks`);
	const started = new Date();
	const done = await holdingChannel(
		channel,
		{ purpose: "sync-pass" },
		async () => {
			const result = await ingest(db, orderId);
			if (result.kind === "applied") await assignOrderPins(db);
			return result;
		},
	);
	if (!done) return { kind: "busy" };
	// Every channel, this one too: its sets share parts with what sold.
	for (const p of await pushMoved(db, started))
		for (const problem of p.problems) console.warn(problem);
	return done;
}
