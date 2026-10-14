import { sql } from "drizzle-orm";
import { type Db, withOwnConnection } from "#/db/client";
import type { SyncedChannel } from "#/diagnostics/checks";
import { recordSyncRun } from "#/diagnostics/runs";
import { assignOrderPins } from "#/shipping/pins";
import { syncAmazon } from "./amazon";
import { syncEbay } from "./ebay";
import { syncShopify } from "./shopify";
import { syncTiktok } from "./tiktok";

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
// twice at once. The lock is held by a transaction on a connection of its own
// and released when that transaction ends, however the pass ends. Not a
// session lock: DATABASE_URL goes through Neon's pooler, which keeps the
// server connection, and a session lock with it, after the client closes.
export async function syncPassAlone(
	db: Db,
	channel: SyncedChannel,
	options: { listings: boolean },
) {
	return withOwnConnection((lockDb) =>
		lockDb.transaction(async (tx) => {
			// The transaction sits idle for the whole pass. Neon ends idle ones
			// after 5 minutes; a Vercel function can't outlive 15.
			await tx.execute(
				sql`set local idle_in_transaction_session_timeout = '15min'`,
			);
			const result = (await tx.execute(
				sql`select pg_try_advisory_xact_lock(hashtext('sync-pass'), hashtext(${channel})) as locked`,
			)) as unknown as { rows: { locked: boolean }[] };
			if (!result.rows[0].locked) return null;
			return syncPass(db, channel, options);
		}),
	);
}
