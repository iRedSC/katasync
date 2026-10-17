import { sql } from "drizzle-orm";
import { type Db, withOwnConnection } from "#/db/client";
import type { SyncedChannel } from "#/diagnostics/checks";
import { recordSyncRun } from "#/diagnostics/runs";
import { applySkusToOrders } from "#/orders/remap";
import { assignOrderPins } from "#/shipping/pins";
import { syncAmazon } from "./amazon";
import { syncEbay } from "./ebay";
import { ingestShopifyOrder, syncShopify } from "./shopify";
import { shippingLocation } from "./stores";
import { ingestTiktokOrder, syncTiktok } from "./tiktok";

// One sync pass of a channel: pull its orders (and, with `listings`, its
// listings), catch up its lines that now have a product, record the run for
// Diagnostics, then pin any new orders to ship.
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
	const result = await recordSyncRun(db, channel, async () => {
		const pass = await passes[channel](db, options.listings);
		const caughtUp = await applySkusToOrders(
			db,
			{ channel },
			await shippingLocation(db),
		);
		return { ...pass, problems: [...pass.problems, ...caughtUp.problems] };
	});
	const pinned = await assignOrderPins(db);
	return { ...result, pinned };
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
	return holdingChannel(channel, { waitFor: "30s" }, () =>
		syncPass(db, channel, options),
	);
}

const ingestOne: Partial<
	Record<SyncedChannel, (db: Db, orderId: string) => Promise<void>>
> = {
	shopify: ingestShopifyOrder,
	tiktok: ingestTiktokOrder,
};

// One order a webhook named, then pins for it if it's new. Gives up at once if
// a pass or another webhook holds the channel: waiting would hold a connection
// per webhook, and a burst of them (a bulk edit in Shopify) would drain the
// pool the lock holder needs. Nothing is lost; webhooks never move the cron's
// cursor, so the next pass reads the change. False if it gave up.
export async function ingestWebhookOrder(
	db: Db,
	channel: SyncedChannel,
	orderId: string,
) {
	const ingest = ingestOne[channel];
	if (!ingest) throw new Error(`${channel} has no webhooks`);
	const done = await holdingChannel(channel, {}, async () => {
		await ingest(db, orderId);
		await assignOrderPins(db);
		return true;
	});
	return done ?? false;
}

// Runs `work` while holding this channel's lock, so only one thing writes a
// channel's orders at a time. Returns null if the lock is taken, or with
// `waitFor`, still taken after that long. The lock is held by a transaction on
// a connection of its own and released when that transaction ends, however
// the work ends. Not a session lock: DATABASE_URL goes through Neon's pooler,
// which keeps the server connection, and a session lock with it, after the
// client closes.
async function holdingChannel<T>(
	channel: SyncedChannel,
	options: { waitFor?: string },
	work: () => Promise<T>,
): Promise<T | null> {
	return withOwnConnection((lockDb) =>
		lockDb.transaction(async (tx) => {
			// The transaction sits idle for the whole pass. Neon ends idle ones
			// after 5 minutes; a Vercel function can't outlive 15.
			await tx.execute(
				sql`set local idle_in_transaction_session_timeout = '15min'`,
			);
			const key = sql`hashtext('sync-pass'), hashtext(${channel})`;
			if (options.waitFor) {
				await tx.execute(
					sql`select set_config('lock_timeout', ${options.waitFor}, true)`,
				);
				try {
					await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
				} catch (error) {
					if (!lockTimedOut(error)) throw error;
					// The transaction is aborted; committing it just rolls back.
					return null;
				}
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

// Postgres's lock_not_available, bare or under drizzle's DrizzleQueryError.
function lockTimedOut(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ("code" in error && error.code === "55P03") return true;
	return "cause" in error && lockTimedOut(error.cause);
}
