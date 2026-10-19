// Pulls orders and listings from every connected channel.
//
//   pnpm sync                one pass of every channel
//   pnpm sync --watch        keep going, each channel on its own schedule
//   pnpm sync --only amazon  just one channel
//   pnpm sync --costs        one cost pass of every channel instead: what
//                            each marketplace charged on orders that are due
//   pnpm sync --costs-history
//                            one-time: ask each marketplace once about every
//                            order too old for cost passes that never was
//   pnpm sync --shopify-history 365
//                            one-time import of Shopify orders placed in the
//                            last 365 days that the regular sync hasn't seen
//   pnpm sync --amazon-returns-history 730
//                            one-time import of Amazon returns requested in
//                            the last 730 days, with their reasons, 60 days
//                            a report (a few minutes each)
//
// A channel without credentials in the environment is skipped. Every pass is
// recorded for Diagnostics (/diagnostics).
import { parseArgs } from "node:util";
import {
	fetchAmazonReturns,
	REPORT_DAYS,
	saveAmazonReturns,
} from "#/channels/amazon-returns";
import { backfillShopify } from "#/channels/shopify";
import { ensureStore } from "#/channels/stores";
import { costPassAlone, syncPass } from "#/channels/sync";
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
		costs: { type: "boolean", default: false },
		"costs-history": { type: "boolean", default: false },
		only: { type: "string" },
		"shopify-history": { type: "string" },
		"amazon-returns-history": { type: "string" },
	},
});

const MINUTE = 60 * 1000;

// Production runs these on Vercel Cron instead (vercel.json), on the same
// schedules. Listings change rarely, so they refresh every 30 minutes.
const channels = [
	{ name: "shopify", every: 2 * MINUTE, listingsEvery: 30 * MINUTE },
	{ name: "ebay", every: 2 * MINUTE, listingsEvery: 30 * MINUTE },
	{ name: "tiktok", every: 2 * MINUTE, listingsEvery: 30 * MINUTE },
	// Amazon allows about one order-list call a minute. Its listings pass
	// also mirrors FBA stock.
	{ name: "amazon", every: 5 * MINUTE, listingsEvery: 30 * MINUTE },
] as const;
// Cost passes, like the costs crons, every 10 minutes per channel.
const COSTS_EVERY = 10 * MINUTE;
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

async function costPass(channel: (typeof channels)[number]) {
	try {
		const result = await costPassAlone(getDb(), channel.name);
		if (!result) return console.log(`${channel.name} costs: last pass still running`);
		console.log(
			`${new Date().toISOString()} ${channel.name} costs: ${result.reported} of ${result.checked} orders reported`,
		);
		for (const problem of result.problems) console.log(`  ${problem}`);
	} catch (error) {
		console.error(`${new Date().toISOString()} ${channel.name} costs failed:`, error);
	}
}

if (values["costs-history"]) {
	// Every channel at once, each in batches until none are left.
	await Promise.all(
		channels.map(async (channel) => {
			if (channelEnv[channel.name].some((name) => !process.env[name])) return;
			let checked = 0;
			let reported = 0;
			for (;;) {
				const result = await costPassAlone(getDb(), channel.name, {
					history: true,
					limit: 50,
				});
				if (!result) {
					await new Promise((resolve) => setTimeout(resolve, 30_000));
					continue;
				}
				if (result.checked === 0) break;
				checked += result.checked;
				reported += result.reported;
				for (const problem of result.problems) console.log(`  ${problem}`);
				console.log(`${channel.name}: ${reported} of ${checked} older orders reported`);
			}
		}),
	);
	process.exit(0);
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

if (values["amazon-returns-history"]) {
	const days = Number(values["amazon-returns-history"]);
	if (!Number.isInteger(days) || days <= 0) throw new Error("Give a number of days");
	const DAY = 24 * 60 * 60 * 1000;
	const store = await ensureStore(getDb(), "amazon", "Amazon US");
	const oldest = Date.now() - days * DAY;
	let saved = 0;
	let skipped = 0;
	// Newest first, so a stopped run has the returns that matter most.
	for (let until = Date.now(); until > oldest; until -= REPORT_DAYS * DAY) {
		const from = new Date(Math.max(oldest, until - REPORT_DAYS * DAY));
		const found = await fetchAmazonReturns(from, new Date(until), 15 * 60 * 1000);
		if (!found) throw new Error(`Amazon's returns report from ${from.toISOString()} wasn't ready in 15 minutes; run again`);
		for (const problem of found.problems) console.log(`  ${problem}`);
		const result = await saveAmazonReturns(getDb(), store.id, found.returns);
		saved += result.saved;
		skipped += result.skipped;
		console.log(`${from.toISOString().slice(0, 10)}: ${result.saved} returns saved, ${result.skipped} for orders katasync doesn't have`);
	}
	console.log(`Amazon: ${saved} returns saved, ${skipped} skipped`);
	process.exit(0);
}

const ready = selected.filter((c) => {
	const missing = channelEnv[c.name].filter((name) => !process.env[name]);
	if (missing.length > 0) console.log(`Skipping ${c.name}: set ${missing.join(", ")}`);
	return missing.length === 0;
});

if (!values.watch) {
	for (const channel of ready) await (values.costs ? costPass : pass)(channel);
	process.exit(0);
}
for (const channel of ready) {
	(async () => {
		for (;;) {
			await costPass(channel);
			await new Promise((resolve) => setTimeout(resolve, COSTS_EVERY));
		}
	})();
}
for (const channel of ready) {
	(async () => {
		for (;;) {
			await pass(channel);
			await new Promise((resolve) => setTimeout(resolve, channel.every));
		}
	})();
}
