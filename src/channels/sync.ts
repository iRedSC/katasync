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
// twice at once. The lock lives on a connection of its own, so it is released
// when the pass ends or the function dies.
export async function syncPassAlone(
	db: Db,
	channel: SyncedChannel,
	options: { listings: boolean },
) {
	return withOwnConnection(async (lockDb) => {
		const result = (await lockDb.execute(
			sql`select pg_try_advisory_lock(hashtext('sync'), hashtext(${channel})) as locked`,
		)) as unknown as { rows: { locked: boolean }[] };
		if (!result.rows[0].locked) return null;
		return syncPass(db, channel, options);
	});
}
