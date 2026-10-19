import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
import { type ChannelReturn, saveReturns } from "#/orders/return-requests";
import { fetchAmazonReturns, REPORT_DAYS } from "./amazon-returns";
import { fetchEbayReturns, HISTORY_DAYS } from "./ebay-returns";
import { fetchShopifyReturns } from "./shopify/returns";

// One-time import of older returns, for `pnpm sync --returns-history`.
// Regular passes only reread the last week or two months.

const DAY = 24 * 60 * 60 * 1000;

export const returnChannels = ["amazon", "shopify", "ebay"] as const;
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
		fetch: async (from, until) => ({
			returns: await fetchShopifyReturns(from, until),
			problems: [],
		}),
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
// can't look back past 18 months, so it stops there.
export async function backfillReturns(
	db: Db,
	channel: ReturnChannel,
	days: number,
	log: (line: string) => void,
) {
	const [store] = await db
		.select()
		.from(stores)
		.where(eq(stores.channel, channel))
		.limit(1);
	if (!store) return log(`${channel}: no store synced yet`);
	const { days: step, fetch } = windows[channel];
	const reach = channel === "ebay" ? Math.min(days, HISTORY_DAYS) : days;
	const oldest = Date.now() - reach * DAY;
	let saved = 0;
	let skipped = 0;
	for (let until = Date.now(); until > oldest; until -= step * DAY) {
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
		log(
			`${channel} from ${from.toISOString().slice(0, 10)}: ${result.saved} saved, ${result.skipped} for orders katasync doesn't have`,
		);
	}
	log(`${channel}: ${saved} returns saved, ${skipped} skipped`);
}
