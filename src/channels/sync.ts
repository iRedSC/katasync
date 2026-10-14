import { sql } from "drizzle-orm";
import { type Db, withOwnConnection } from "#/db/client";
import type { SyncedChannel } from "#/diagnostics/checks";
import { recordSyncRun } from "#/diagnostics/runs";
import { assignOrderPins } from "#/shipping/pins";
import { syncAmazon } from "./amazon";
import { syncEbay } from "./ebay";
import { ingestShopifyOrder, syncShopify } from "./shopify";
import { ingestTiktokOrder, syncTiktok } from "./tiktok";

// One sync pass of a channel: pull its orders (and, with `listings`, its
// listings), record the run for Diagnostics, then pin any new orders to ship.
// Shared by `pnpm sync` (scripts/sync.ts) and the Vercel crons
// (src/routes/api/cron/sync.$channel.ts). Server only.

const passes: Record<
	SyncedChannel,
	(db: Db, listings: boolean) => ReturnType<typeof syncEbay>
> = {
	shopify: (db, listings) => syncShopify(db, { listings }),
	ebay: (db) => syncEbay(db),
	tiktok: (db, listings) => syncTiktok(db, { listings }),
	amazon: (db) => syncAmazon(db),
};

export const isSyncedChannel = (name: string): name is SyncedChannel =>
	Object.hasOwn(passes, name);

export async function syncPass(
	db: Db,
	channel: SyncedChannel,
	options: { listings: boolean },
) {
	const result = await recordSyncRun(db, channel, () =>
		passes[channel](db, options.listings),
	);
	const pinned = await assignOrderPins(db);
	return { ...result, pinned };
}

// The same pass, unless one of this channel is already running anywhere: a
// slow pass would otherwise overlap the next cron and import the same orders
// twice at once.
export async function syncPassAlone(
	db: Db,
	channel: SyncedChannel,
	options: { listings: boolean },
) {
	return holdingChannel(channel, { wait: false }, () =>
		syncPass(db, channel, options),
	);
}

const ingestOne: Partial<
	Record<SyncedChannel, (db: Db, orderId: string) => Promise<void>>
> = {
	shopify: ingestShopifyOrder,
	tiktok: ingestTiktokOrder,
};

// One order a webhook named, then pins for it if it's new. Waits for a pass
// already running instead of skipping: that pass may have read its orders
// before this one changed. Failing is fine; the next pass picks it up.
export async function ingestWebhookOrder(
	db: Db,
	channel: SyncedChannel,
	orderId: string,
) {
	const ingest = ingestOne[channel];
	if (!ingest) throw new Error(`${channel} has no webhooks`);
	await holdingChannel(channel, { wait: true }, async () => {
		await ingest(db, orderId);
		await assignOrderPins(db);
	});
}

// Runs `work` while holding this channel's lock, so only one thing writes a
// channel's orders at a time. Without `wait`, returns null if the lock is
// taken. The lock is held by a transaction on a connection of its own and
// released when that transaction ends, however the work ends. Not a session
// lock: DATABASE_URL goes through Neon's pooler, which keeps the server
// connection, and a session lock with it, after the client closes.
function holdingChannel<T>(
	channel: SyncedChannel,
	options: { wait: boolean },
	work: () => Promise<T>,
) {
	return withOwnConnection((lockDb) =>
		lockDb.transaction(async (tx) => {
			// The transaction sits idle for the whole pass. Neon ends idle ones
			// after 5 minutes; a Vercel function can't outlive 15.
			await tx.execute(
				sql`set local idle_in_transaction_session_timeout = '15min'`,
			);
			const key = sql`hashtext('sync-pass'), hashtext(${channel})`;
			if (options.wait) {
				// A pass rarely takes this long; past it, leave the order to the
				// next one.
				await tx.execute(sql`set local lock_timeout = '2min'`);
				await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
			} else {
				const result = (await tx.execute(
					sql`select pg_try_advisory_xact_lock(${key}) as locked`,
				)) as unknown as { rows: { locked: boolean }[] };
				if (!result.rows[0].locked) return null;
			}
			return work();
		}),
	);
}
