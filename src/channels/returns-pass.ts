import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "#/db/client";
import { feedHealth, returnRequests, stores } from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import type { FeedOutcome } from "#/diagnostics/feed-health";
import { recordFeed } from "#/diagnostics/feed-record";
import { errorText } from "#/diagnostics/runs";
import { type ChannelReturn, importReturns } from "#/orders/return-requests";
import { REPORT_DAYS, recentAmazonReturns } from "./amazon-returns";
import {
	DISCOVERY_DAYS,
	fetchEbayReturns,
	fetchOlderOpenReturns,
} from "./ebay-returns";
import { fetchShopifyReturns } from "./shopify/returns";
import { fetchTiktokReturns } from "./tiktok-returns";

// One returns pass of a channel, every 15 minutes on its own cron
// (src/routes/api/cron/returns.$channel.ts), apart from orders and listings.
// Each pass reads from a little before where the last good one read
// through, so an outage is caught up when it ends rather than skipped.
// Server only.

const DAY = 24 * 60 * 60 * 1000;
// Reread before the mark: a return on an order the orders pass hasn't
// brought in yet is skipped, and comes in once the order does.
const OVERLAP_MS = DAY;

// first: how far back a channel's first pass reads. reread: how far back
// every pass reads at least. span: the most one pass reads, so a long
// outage is caught up over several passes inside Vercel's time limit.
type Reach = { firstDays: number; rereadDays: number; spanDays: number };

export type ReturnsWindow = { from: Date; until: Date };

// What the next pass reads, from where the last good one read through.
export function returnsWindow(
	coveredThrough: Date | null,
	now: Date,
	reach: Reach,
): ReturnsWindow {
	const from = new Date(
		coveredThrough
			? Math.min(
					coveredThrough.getTime() - OVERLAP_MS,
					now.getTime() - reach.rereadDays * DAY,
				)
			: now.getTime() - reach.firstDays * DAY,
	);
	const until = new Date(
		Math.min(now.getTime(), from.getTime() + reach.spanDays * DAY),
	);
	return { from, until };
}

type Found = ChannelReturn[] | { returns: ChannelReturn[]; problems: string[] };

const readers: Record<
	SyncedChannel,
	{
		reach: Reach;
		read: (db: Db, w: ReturnsWindow, now: Date) => Promise<Found | null>;
	}
> = {
	// A return changes its order, so orders changed in the window carry it.
	shopify: {
		reach: { firstDays: 7, rereadDays: 0, spanDays: 30 },
		read: (_db, w) => fetchShopifyReturns(w.from, w.until),
	},
	tiktok: {
		reach: { firstDays: 7, rereadDays: 0, spanDays: 30 },
		read: (_db, w) => fetchTiktokReturns(w.from, w.until),
	},
	// eBay searches by when a return was opened, so a change to one is only
	// seen by reading its window again: the last two months every pass, and
	// each window holding an older one still open.
	ebay: {
		reach: {
			firstDays: DISCOVERY_DAYS,
			rereadDays: DISCOVERY_DAYS,
			spanDays: DISCOVERY_DAYS,
		},
		read: async (db, w, now) => [
			...(await fetchEbayReturns(w.from, w.until)),
			...(w.until.getTime() === now.getTime()
				? await fetchOlderOpenReturns(await openOlderReturns(db, now), now)
				: []),
		],
	},
	// One report of the last 60 days, shared by passes close together. It
	// always reads up to now, so a mark older than its reach is named for a
	// history run instead.
	amazon: {
		reach: {
			firstDays: REPORT_DAYS,
			rereadDays: REPORT_DAYS,
			spanDays: Number.POSITIVE_INFINITY,
		},
		read: () => recentAmazonReturns(),
	},
};

// eBay returns still open that discovery no longer reads by creation date.
function openOlderReturns(db: Db, now: Date) {
	return db
		.select({
			externalId: returnRequests.externalId,
			requestedAt: returnRequests.requestedAt,
		})
		.from(returnRequests)
		.where(
			and(
				eq(returnRequests.billedBy, "ebay"),
				inArray(returnRequests.status, ["requested", "shipped", "delivered"]),
				lt(
					returnRequests.requestedAt,
					new Date(now.getTime() - DISCOVERY_DAYS * DAY),
				),
			),
		);
}

// Reads the channel's returns from where the last good pass left off, and
// records how it went on the returns feed. A failure is the feed's
// outcome, not thrown.
export async function returnsPass(
	db: Db,
	channel: SyncedChannel,
	now = new Date(),
): Promise<FeedOutcome> {
	const outcome = await readReturns(db, channel, now).catch(
		(error: unknown): FeedOutcome => ({
			kind: "failed",
			error: errorText(error),
		}),
	);
	await recordFeed(db, channel, "returns", now, outcome);
	return outcome;
}

async function readReturns(
	db: Db,
	channel: SyncedChannel,
	now: Date,
): Promise<FeedOutcome> {
	const [store] = await db
		.select()
		.from(stores)
		.where(eq(stores.channel, channel))
		.limit(1);
	if (!store)
		return {
			kind: "failed",
			error: `No ${channel} store yet: its orders haven't synced`,
		};
	const [health] = await db
		.select({ coveredThrough: feedHealth.coveredThrough })
		.from(feedHealth)
		.where(
			and(eq(feedHealth.channel, channel), eq(feedHealth.feed, "returns")),
		);
	const { reach, read } = readers[channel];
	const window = returnsWindow(health?.coveredThrough ?? null, now, reach);
	const outcome = await importReturns(db, store, () => read(db, window, now));
	if (outcome.kind !== "read") return outcome;
	const problems = [...outcome.problems];
	const reached = now.getTime() - REPORT_DAYS * DAY;
	if (channel === "amazon" && window.from.getTime() < reached)
		problems.push(
			`Amazon returns before ${new Date(reached).toISOString().slice(0, 10)} weren't read: run pnpm sync --returns-history ${Math.ceil((now.getTime() - window.from.getTime()) / DAY)} --only amazon`,
		);
	return { kind: "read", problems, coveredThrough: window.until };
}
