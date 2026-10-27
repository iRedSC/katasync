import type { Db } from "#/db/client";
import type { SyncedChannel } from "#/diagnostics/checks";
import { errorText } from "#/diagnostics/runs";
import { returnsPassAlone, syncPassAlone } from "./sync";

// One channel's turn in `pnpm sync` (scripts/sync.ts): its orders pass, then
// its returns pass when one is due, each on its own, so one failing doesn't
// stop the other. Each takes the channel's lock like the crons and webhooks,
// and a turn that finds it taken skips, not fails. Lines are what to print; ok
// is whether both worked.

type Runs = {
	syncPassAlone: typeof syncPassAlone;
	returnsPassAlone: typeof returnsPassAlone;
};

export async function channelPass(
	db: Db,
	channel: SyncedChannel,
	options: { listings: boolean; returns: boolean },
	run: Runs = { syncPassAlone, returnsPassAlone },
): Promise<{ ok: boolean; lines: string[] }> {
	const lines: string[] = [];
	let ok = true;
	const started = Date.now();
	try {
		const result = await run.syncPassAlone(db, channel, {
			listings: options.listings,
		});
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		if (!result)
			lines.push(
				`${new Date().toISOString()} ${channel}: another pass or a webhook is running, skipped`,
			);
		else {
			lines.push(
				`${new Date().toISOString()} ${result.store}: ${result.orders} orders in ${seconds}s`,
				...result.problems.map((p) => `  ${p}`),
			);
			if (result.pinned > 0)
				lines.push(`  ${result.pinned} new orders to ship got pins`);
		}
	} catch (error) {
		// An outage or an expired token; the returns pass still runs.
		ok = false;
		lines.push(
			`${new Date().toISOString()} ${channel} failed: ${errorText(error)}`,
		);
	}
	if (!options.returns) return { ok, lines };
	const outcome = await run.returnsPassAlone(db, channel);
	if (!outcome) lines.push(`${channel} returns: last pass still running`);
	else if (outcome.kind === "failed") {
		ok = false;
		lines.push(`${channel} returns failed: ${outcome.error}`);
	} else if (outcome.kind === "pending")
		lines.push(`${channel} returns: waiting on the marketplace's report`);
	else {
		lines.push(
			outcome.kind === "catching_up"
				? `${channel} returns: read through ${outcome.readThrough.toISOString()}, catching up`
				: `${channel} returns: read`,
			...outcome.problems.map((p) => `  ${p}`),
		);
	}
	return { ok, lines };
}
