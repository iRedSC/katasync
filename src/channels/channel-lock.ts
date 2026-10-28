import { sql } from "drizzle-orm";
import { withOwnConnection } from "#/db/client";
import type { SyncedChannel } from "#/diagnostics/checks";

// Runs `work` while holding this channel's lock for `purpose`, so only one
// thing writes a channel's orders (sync-pass), charges (cost-pass) or
// payouts (payout-refresh) at a time. Returns null if the lock is taken, or with
// `waitFor`, still taken after that long. The lock is held by a transaction on
// a connection of its own and released when that transaction ends, however
// the work ends. Not a session lock: DATABASE_URL goes through Neon's pooler,
// which keeps the server connection, and a session lock with it, after the
// client closes.
export async function holdingChannel<T>(
	channel: SyncedChannel,
	options: {
		purpose:
			| "sync-pass"
			| "cost-pass"
			| "cost-history"
			| "returns-pass"
			| "payout-refresh";
		waitFor?: string;
	},
	work: () => Promise<T>,
): Promise<T | null> {
	return withOwnConnection((lockDb) =>
		lockDb.transaction(async (tx) => {
			// The transaction sits idle for the whole pass. Neon ends idle ones
			// after 5 minutes; a Vercel function can't outlive 15.
			await tx.execute(
				sql`set local idle_in_transaction_session_timeout = '15min'`,
			);
			const key = sql`hashtext(${options.purpose}), hashtext(${channel})`;
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
