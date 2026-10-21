// Reads every marketplace's payouts since a date, for months before payouts
// were kept. Safe to run again; payouts already saved are updated. The cost
// cron keeps the last 45 days current after this.
//
//   pnpm payouts:backfill 2025-10-01
import { getDb } from "#/db/client";
import { channelEnv, missingEnv, type SyncedChannel } from "#/diagnostics/checks";
import { refreshPayouts } from "#/payouts/refresh";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const since = new Date(process.argv[2] ?? "");
if (Number.isNaN(since.getTime())) {
	console.error("Give the date to read from: pnpm payouts:backfill 2025-10-01");
	process.exit(1);
}
const db = getDb();
for (const channel of Object.keys(channelEnv) as SyncedChannel[]) {
	if (missingEnv(channelEnv[channel]).length > 0) {
		console.log(`${channel}: not connected`);
		continue;
	}
	const { saved, error } = await refreshPayouts(db, channel, since);
	console.log(error ? `${channel}: ${error}` : `${channel}: ${saved} payouts`);
}
process.exit(0);
