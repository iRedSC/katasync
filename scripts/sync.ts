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
//   pnpm sync --orders-history 365
//                            one-time import of orders placed in the last
//                            365 days that the regular sync hasn't seen, on
//                            every channel at once (--only one of them)
//   pnpm sync --returns-history 365
//                            one-time import of returns buyers opened in the
//                            last 365 days on Amazon, Shopify, eBay and
//                            TikTok, with their reasons (--only one of them)
//
// A channel without credentials in the environment is skipped. Every pass is
// recorded for Diagnostics (/diagnostics). A one-shot run still tries every
// channel, then exits nonzero if any of them failed.
import { parseArgs } from "node:util";
import {
	backfillOrders,
	type OrderChannel,
	orderChannels,
} from "#/channels/orders-history";
import {
	backfillReturns,
	type ReturnChannel,
	returnChannels,
} from "#/channels/returns-history";
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
		"orders-history": { type: "string" },
		"returns-history": { type: "string" },
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

// Each returns whether the pass worked, for the one-shot exit status.
async function pass(channel: (typeof channels)[number]): Promise<boolean> {
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
		return true;
	} catch (error) {
		// One channel failing (an outage, an expired token) doesn't stop the rest.
		console.error(`${new Date().toISOString()} ${channel.name} failed:`, error);
		return false;
	}
}

async function costPass(channel: (typeof channels)[number]): Promise<boolean> {
	try {
		const result = await costPassAlone(getDb(), channel.name);
		if (!result) {
			console.log(`${channel.name} costs: last pass still running`);
			return true;
		}
		console.log(
			`${new Date().toISOString()} ${channel.name} costs: ${result.reported} of ${result.checked} orders reported`,
		);
		for (const problem of result.problems) console.log(`  ${problem}`);
		return true;
	} catch (error) {
		console.error(
			`${new Date().toISOString()} ${channel.name} costs failed:`,
			error,
		);
		return false;
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
				console.log(
					`${channel.name}: ${reported} of ${checked} older orders reported`,
				);
			}
		}),
	);
	process.exit(0);
}

if (values["orders-history"]) {
	const days = Number(values["orders-history"]);
	if (!Number.isInteger(days) || days <= 0)
		throw new Error("Give a number of days");
	const wanted = orderChannels.filter(
		(c): c is OrderChannel =>
			(!values.only || c === values.only) &&
			channelEnv[c].every((name) => process.env[name]),
	);
	// At once: Amazon's rate limits take hours, which the rest shouldn't wait on.
	const results = await Promise.all(
		wanted.map((channel) =>
			backfillOrders(getDb(), channel, days, console.log).then(
				() => true,
				(error) => {
					console.error(`${channel} history stopped:`, error);
					return false;
				},
			),
		),
	);
	process.exit(results.every(Boolean) ? 0 : 1);
}

if (values["returns-history"]) {
	const days = Number(values["returns-history"]);
	if (!Number.isInteger(days) || days <= 0)
		throw new Error("Give a number of days");
	const wanted = returnChannels.filter(
		(c): c is ReturnChannel =>
			(!values.only || c === values.only) &&
			channelEnv[c].every((name) => process.env[name]),
	);
	const results: boolean[] = [];
	for (const channel of wanted)
		results.push(
			await backfillReturns(getDb(), channel, days, console.log).then(
				() => true,
				(error) => {
					console.error(`${channel} returns history stopped:`, error);
					return false;
				},
			),
		);
	process.exit(results.every(Boolean) ? 0 : 1);
}

const ready = selected.filter((c) => {
	const missing = channelEnv[c.name].filter((name) => !process.env[name]);
	if (missing.length > 0)
		console.log(`Skipping ${c.name}: set ${missing.join(", ")}`);
	return missing.length === 0;
});

if (!values.watch) {
	const results: boolean[] = [];
	for (const channel of ready)
		results.push(await (values.costs ? costPass : pass)(channel));
	process.exit(results.every(Boolean) ? 0 : 1);
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
