import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
import { settleGaps } from "#/diagnostics/feed-record";
import { type ChannelReturn, saveReturns } from "#/orders/return-requests";
import { fetchAmazonReturns, REPORT_DAYS } from "./amazon-returns";
import { fetchEbayReturns, HISTORY_DAYS } from "./ebay-returns";
import { fetchShopifyReturns } from "./shopify/returns";
import { withRecords } from "./tiktok-return-history";
import { fetchTiktokReturns } from "./tiktok-returns";

// One-time import of older returns, for `pnpm sync --returns-history`.
// Regular passes only reread the last week or two months.

const DAY = 24 * 60 * 60 * 1000;

export const returnChannels = ["amazon", "shopify", "ebay", "tiktok"] as const;
export type ReturnChannel = (typeof returnChannels)[number];

// Each channel's returns in one stretch of time, and the longest stretch it
// takes at once.
const windows: Record<
	ReturnChannel,
	{
		days: number;
		fetch: (
			from: Date,
			until: Date,
		) => Promise<{ returns: ChannelReturn[]; problems: string[] } | null>;
	}
> = {
	// Amazon builds a report per window; a big one can take minutes.
	amazon: {
		days: REPORT_DAYS,
		fetch: (from, until) => fetchAmazonReturns(from, until, 15 * 60 * 1000),
	},
	shopify: {
		days: 90,
		fetch: async (from, until) => {
			const found = await fetchShopifyReturns(from, until);
			return {
				returns: found.returns,
				problems: found.held.map((h) => h.detail),
			};
		},
	},
	tiktok: {
		days: 90,
		fetch: async (from, until) => {
			const found = await fetchTiktokReturns(from, until, "create");
			// Every record read again; pictures kept before download again.
			return withRecords(
				found,
				new Map(found.map((r) => [r.externalId, new Map()])),
			);
		},
	},
	ebay: {
		days: 90,
		fetch: async (from, until) => ({
			returns: await fetchEbayReturns(from, until),
			problems: [],
		}),
	},
};

// Newest first, so a stopped run has the returns that matter most. eBay
// can't look back past 18 months, so it stops there. Each window read
// closes the returns feed's unread gaps (feed_gaps) the run has covered
// so far, unbroken from now: those days are read now.
export async function backfillReturns(
	db: Db,
	channel: ReturnChannel,
	days: number,
	log: (line: string) => void,
	fetch = windows[channel].fetch,
) {
	const [store] = await db
		.select()
		.from(stores)
		.where(eq(stores.channel, channel))
		.limit(1);
	if (!store) return log(`${channel}: no store synced yet`);
	const step = windows[channel].days;
	const reach = channel === "ebay" ? Math.min(days, HISTORY_DAYS) : days;
	const oldest = Date.now() - reach * DAY;
	let saved = 0;
	let skipped = 0;
	const newest = Date.now();
	for (let until = newest; until > oldest; until -= step * DAY) {
		const from = new Date(Math.max(oldest, until - step * DAY));
		const found = await fetch(from, new Date(until));
		if (!found)
			throw new Error(
				`${channel} returns from ${from.toISOString().slice(0, 10)} weren't ready; run again`,
			);
		for (const problem of found.problems) log(`  ${problem}`);
		const result = await saveReturns(db, store, found.returns);
		saved += result.saved;
		skipped += result.skipped;
		await settleGaps(
			db,
			channel,
			"returns",
			{ kind: "unread", from, until: new Date(newest) },
			[],
		);
		log(
			`${channel} from ${from.toISOString().slice(0, 10)}: ${result.saved} saved, ${result.skipped} for orders katasync doesn't have`,
		);
	}
	log(`${channel}: ${saved} returns saved, ${skipped} skipped`);
}
