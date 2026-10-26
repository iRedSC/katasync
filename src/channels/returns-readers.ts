import { and, eq, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import { returnRequests } from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import type { FoundReturns } from "#/orders/return-requests";
import { REPORT_DAYS, recentAmazonReturns } from "./amazon-returns";
import {
	DISCOVERY_DAYS,
	fetchEbayReturns,
	fetchOpenReturns,
} from "./ebay-returns";
import { fetchShopifyReturns } from "./shopify/returns";
import {
	retryUnreadNotes,
	tiktokReturnsWithNotes,
} from "./tiktok-return-notes";
import { fetchTiktokReturns } from "./tiktok-returns";

// How each channel's returns are read for a returns pass (returns-pass.ts),
// in the marketplace's own time: TikTok's and Shopify's by when they last
// changed, eBay's and Amazon's by when they were opened. Server only.

export type ReturnsWindow = { from: Date; until: Date };

export type ReturnsReader = {
	// How far back a first pass reads.
	firstDays: number;
	// The most one read takes, so a long catch-up saves as it goes.
	chunkDays: number;
	// Every pass reads at least this far back, and no further (Amazon's
	// report): what's older than that is a gap for a history import.
	reachDays?: number;
	// A window's returns, and the stretch really read when the marketplace
	// says it's other than asked. Null while there's nothing to read yet.
	read: (
		w: ReturnsWindow,
	) => Promise<{ found: FoundReturns; covered?: ReturnsWindow } | null>;
	// Whether a held record's moment can be read again on its own.
	rereadsGaps: boolean;
	// More to do once caught up, at its own pace.
	after?: (now: Date) => Promise<FoundReturns>;
};

// eBay's returns still open here, read again once an hour: a change to one
// (shipped, closed) only shows by reading its window again, and every 15
// minutes would read two months of returns 96 times a day.
export const ebayRechecksOpen = (now: Date) => now.getUTCMinutes() < 15;

function openEbayReturns(db: Db) {
	return db
		.select({
			externalId: returnRequests.externalId,
			requestedAt: returnRequests.requestedAt,
		})
		.from(returnRequests)
		.where(
			and(
				eq(returnRequests.billedBy, "ebay"),
				ne(returnRequests.waitingOn, "nobody"),
			),
		);
}

export function returnsReaders(db: Db): Record<SyncedChannel, ReturnsReader> {
	return {
		// A return changes its order, so orders changed in the window carry it.
		shopify: {
			firstDays: 7,
			chunkDays: 30,
			rereadsGaps: true,
			read: async (w) => ({
				found: await fetchShopifyReturns(w.from, w.until),
			}),
		},
		tiktok: {
			firstDays: 7,
			chunkDays: 30,
			rereadsGaps: true,
			read: async (w) => ({
				found: await tiktokReturnsWithNotes(
					db,
					await fetchTiktokReturns(w.from, w.until),
				),
			}),
			after: async () => ({
				returns: [],
				problems: await retryUnreadNotes(db),
			}),
		},
		ebay: {
			firstDays: DISCOVERY_DAYS,
			chunkDays: 30,
			rereadsGaps: true,
			read: async (w) => ({ found: await fetchEbayReturns(w.from, w.until) }),
			after: async (now) =>
				ebayRechecksOpen(now)
					? await fetchOpenReturns(await openEbayReturns(db), now)
					: [],
		},
		// One report of the last 60 days every pass, so a change to a return
		// in it comes through; a recent pass's is shared when it covers that.
		amazon: {
			firstDays: REPORT_DAYS,
			chunkDays: Number.POSITIVE_INFINITY,
			reachDays: REPORT_DAYS,
			rereadsGaps: false,
			read: async (w) => {
				const read = await recentAmazonReturns(w.from, w.until.getTime());
				return (
					read && {
						found: read,
						covered: { from: read.from, until: read.until },
					}
				);
			},
		},
	};
}
