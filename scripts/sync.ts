// Pulls orders (and Shopify listings) from every connected channel.
//
//   pnpm sync                one pass of every channel
//   pnpm sync --watch        keep going, each channel on its own schedule
//   pnpm sync --only amazon  just one channel
//
// A channel without credentials in the environment is skipped.
import { parseArgs } from "node:util";
import { syncAmazon } from "#/channels/amazon";
import { syncEbay } from "#/channels/ebay";
import { syncShopify } from "#/channels/shopify";
import { getDb } from "#/db/client";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const { values } = parseArgs({
	options: {
		watch: { type: "boolean", default: false },
		only: { type: "string" },
	},
});

const MINUTE = 60 * 1000;
let shopifyListingsAt = 0;

const channels = [
	{
		name: "shopify",
		every: 2 * MINUTE,
		env: ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN"],
		run: async () => {
			// Listings change rarely; refresh them every 30 minutes.
			const listings = Date.now() - shopifyListingsAt >= 30 * MINUTE;
			const result = await syncShopify(getDb(), { listings });
			if (listings) shopifyListingsAt = Date.now();
			return result;
		},
	},
	{
		name: "ebay",
		every: 2 * MINUTE,
		env: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN"],
		run: () => syncEbay(getDb()),
	},
	{
		// Amazon allows about one order-list call a minute.
		name: "amazon",
		every: 5 * MINUTE,
		env: ["AMAZON_CLIENT_ID", "AMAZON_CLIENT_SECRET", "AMAZON_REFRESH_TOKEN"],
		run: () => syncAmazon(getDb()),
	},
].filter((c) => !values.only || c.name === values.only);

async function pass(channel: (typeof channels)[number]) {
	const started = Date.now();
	try {
		const result = await channel.run();
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(
			`${new Date().toISOString()} ${result.store}: ${result.orders} orders in ${seconds}s`,
		);
		for (const problem of result.problems) console.log(`  ${problem}`);
	} catch (error) {
		// One channel failing (an outage, an expired token) doesn't stop the rest.
		console.error(`${new Date().toISOString()} ${channel.name} failed:`, error);
	}
}

const ready = channels.filter((c) => {
	const missing = c.env.filter((name) => !process.env[name]);
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
