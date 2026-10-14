// Pulls orders (and Shopify listings) from every connected channel.
//
//   pnpm sync                one pass of every channel
//   pnpm sync --watch        keep going, each channel on its own schedule
//   pnpm sync --only amazon  just one channel
//   pnpm sync --shopify-history 365
//                            one-time import of Shopify orders placed in the
//                            last 365 days that the regular sync hasn't seen
//
// A channel without credentials in the environment is skipped. Every pass is
// recorded for Diagnostics (/diagnostics).
import { parseArgs } from "node:util";
import { backfillShopify } from "#/channels/shopify";
import { syncPass } from "#/channels/sync";
import { getDb } from "#/db/client";
import { channelEnv } from "#/diagnostics/checks";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const { values } = parseArgs({
	options: {
		watch: { type: "boolean", default: false },
		only: { type: "string" },
		"shopify-history": { type: "string" },
	},
});

const MINUTE = 60 * 1000;

// Production runs these on Vercel Cron instead (vercel.json), on the same
// schedules. Listings change rarely, so they refresh every 30 minutes.
const channels = [
	{ name: "shopify", every: 2 * MINUTE, listingsEvery: 30 * MINUTE },
	{ name: "ebay", every: 2 * MINUTE },
	{ name: "tiktok", every: 2 * MINUTE, listingsEvery: 30 * MINUTE },
	// Amazon allows about one order-list call a minute.
	{ name: "amazon", every: 5 * MINUTE },
] as const;
const listingsAt = new Map<string, number>();
const selected = channels.filter((c) => !values.only || c.name === values.only);

async function pass(channel: (typeof channels)[number]) {
	const started = Date.now();
	const listings =
		"listingsEvery" in channel &&
		started - (listingsAt.get(channel.name) ?? 0) >= channel.listingsEvery;
	try {
		const result = await syncPass(getDb(), channel.name, { listings });
		if (listings) listingsAt.set(channel.name, started);
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(
			`${new Date().toISOString()} ${result.store}: ${result.orders} orders in ${seconds}s`,
		);
		for (const problem of result.problems) console.log(`  ${problem}`);
		if (result.pinned > 0)
			console.log(`  ${result.pinned} new orders to ship got pins`);
	} catch (error) {
		// One channel failing (an outage, an expired token) doesn't stop the rest.
		console.error(`${new Date().toISOString()} ${channel.name} failed:`, error);
	}
}

if (values["shopify-history"]) {
	const days = Number(values["shopify-history"]);
	if (!Number.isInteger(days) || days <= 0) throw new Error("Give a number of days");
	// The regular sync already covers the newest 60 days.
	const until = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
	const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const started = Date.now();
	const result = await backfillShopify(getDb(), from, until);
	console.log(
		`${result.store}: ${result.orders} older orders in ${((Date.now() - started) / 1000).toFixed(0)}s`,
	);
	for (const problem of result.problems) console.log(`  ${problem}`);
	process.exit(0);
}

const ready = selected.filter((c) => {
	const missing = channelEnv[c.name].filter((name) => !process.env[name]);
	if (missing.length > 0) console.log(`Skipping ${c.name}: set ${missing.join(", ")}`);
	return missing.length === 0;
});

if (!values.watch) {
	for (const channel of ready) await pass(channel);
	process.exit(0);
}
for (const channel of ready) {
	(async () => {
		for (;;) {
			await pass(channel);
			await new Promise((resolve) => setTimeout(resolve, channel.every));
		}
	})();
}
