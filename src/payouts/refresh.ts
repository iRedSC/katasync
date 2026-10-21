import { sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { payoutChecks, payouts } from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import { errorText } from "#/diagnostics/runs";
import { fetchAmazonPayouts } from "./amazon";
import { fetchEbayPayouts } from "./ebay";
import { fetchShopifyPayouts } from "./shopify";
import { fetchTiktokPayouts } from "./tiktok";
import type { FetchedPayout } from "./types";

// Keeps each marketplace's payouts in step: asks for every payout since
// `since` and saves them, a payout's status and amount replaced by the
// marketplace's latest word. Payouts are never deleted: one the marketplace
// stops listing (older than it keeps) stays as it was last seen. The check
// is recorded either way, with the error if the ask failed, so the Reports
// tab can say why a marketplace's deposits are missing.

const FETCHERS: Record<
	SyncedChannel,
	(since: Date) => Promise<FetchedPayout[]>
> = {
	shopify: fetchShopifyPayouts,
	amazon: fetchAmazonPayouts,
	ebay: fetchEbayPayouts,
	tiktok: fetchTiktokPayouts,
};

// A regular pass looks back far enough to see pending payouts land.
export const REFRESH_DAYS = 45;

export async function refreshPayouts(
	db: Db,
	channel: SyncedChannel,
	since = new Date(Date.now() - REFRESH_DAYS * 24 * 60 * 60 * 1000),
): Promise<{ saved: number; error: string | null }> {
	let found: FetchedPayout[];
	try {
		found = await FETCHERS[channel](since);
	} catch (e) {
		const error = errorText(e);
		await recordCheck(db, channel, error);
		return { saved: 0, error };
	}
	if (found.length > 0)
		await db
			.insert(payouts)
			.values(found.map((p) => ({ ...p, channel })))
			.onConflictDoUpdate({
				target: [payouts.channel, payouts.externalId],
				set: {
					status: sql`excluded.status`,
					depositedAt: sql`excluded.deposited_at`,
					amount: sql`excluded.amount`,
					currency: sql`excluded.currency`,
					bankTail: sql`excluded.bank_tail`,
					reference: sql`excluded.reference`,
					fetchedAt: sql`now()`,
				},
			});
	await recordCheck(db, channel, null);
	return { saved: found.length, error: null };
}

async function recordCheck(
	db: Db,
	channel: SyncedChannel,
	error: string | null,
) {
	const checkedAt = new Date();
	await db
		.insert(payoutChecks)
		.values({ channel, checkedAt, error })
		.onConflictDoUpdate({
			target: payoutChecks.channel,
			set: { checkedAt, error },
		});
}
