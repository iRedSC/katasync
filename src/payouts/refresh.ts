import { and, eq, min, sql } from "drizzle-orm";
import { holdingChannel } from "#/channels/channel-lock";
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
// stops listing (older than it keeps) stays as it was last seen. The save and
// its check are one transaction, so a check never says a save worked when it
// didn't. The check is recorded either way, with the error if the ask or the
// save failed, so the Reports tab can say why a marketplace's deposits are
// missing.
//
// Each channel's refresh holds a lock of its own from the ask through the
// save: an overlapping one would save what it heard earlier over what the
// other heard later. The second skips instead (busy).

const FETCHERS: Record<
	SyncedChannel,
	(since: Date) => Promise<FetchedPayout[]>
> = {
	shopify: fetchShopifyPayouts,
	amazon: fetchAmazonPayouts,
	ebay: fetchEbayPayouts,
	tiktok: fetchTiktokPayouts,
};

// A regular pass looks back far enough to see pending payouts land. One
// still pending from before that keeps the pass looking back to it, less
// MARGIN (Amazon asks by when a group started, which comes before its
// transfer date), up to LONGEST, so it isn't left pending forever.
export const REFRESH_DAYS = 45;
const MARGIN_DAYS = 30;
const LONGEST_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function refreshSince(
	db: Db,
	channel: SyncedChannel,
	now = new Date(),
): Promise<Date> {
	const [{ oldest }] = await db
		.select({ oldest: min(payouts.depositedAt) })
		.from(payouts)
		.where(and(eq(payouts.channel, channel), eq(payouts.status, "pending")));
	const regular = now.getTime() - REFRESH_DAYS * DAY_MS;
	if (!oldest) return new Date(regular);
	return new Date(
		Math.max(
			now.getTime() - LONGEST_DAYS * DAY_MS,
			Math.min(regular, oldest.getTime() - MARGIN_DAYS * DAY_MS),
		),
	);
}

export type PayoutRefresh =
	| { kind: "saved"; saved: number }
	| { kind: "failed"; error: string }
	| { kind: "busy" };

export async function refreshPayouts(
	db: Db,
	channel: SyncedChannel,
	since?: Date,
): Promise<PayoutRefresh> {
	try {
		const done = await holdingChannel(
			channel,
			{ purpose: "payout-refresh" },
			async () => {
				const found = await FETCHERS[channel](
					since ?? (await refreshSince(db, channel)),
				);
				await db.transaction(async (tx) => {
					if (found.length > 0)
						await tx
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
					await recordCheck(tx, channel, null);
				});
				return { kind: "saved", saved: found.length } as const;
			},
		);
		return done ?? { kind: "busy" };
	} catch (e) {
		const error = errorText(e);
		// Best effort: if the database is what failed, this fails too, and the
		// error is still returned to the caller.
		await recordCheck(db, channel, error).catch(() => {});
		return { kind: "failed", error };
	}
}

async function recordCheck(
	db: Pick<Db, "insert">,
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
