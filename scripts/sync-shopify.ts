// Pulls Shopify orders (and listings) into katasync.
//
//   pnpm sync:shopify            one pass
//   pnpm sync:shopify --watch    keep going: orders every 2 minutes,
//                                listings every 30
import { parseArgs } from "node:util";
import { getDb } from "#/db/client";
import { syncShopify } from "#/channels/shopify";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const { values } = parseArgs({
	options: { watch: { type: "boolean", default: false } },
});

const ORDER_EVERY = 2 * 60 * 1000;
const LISTINGS_EVERY = 30 * 60 * 1000;
let listingsAt = 0;

async function pass() {
	const listings = Date.now() - listingsAt >= LISTINGS_EVERY;
	const started = Date.now();
	const result = await syncShopify(getDb(), { listings });
	if (listings) listingsAt = started;
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	console.log(
		`${new Date().toISOString()} ${result.store}: ${result.orders} orders` +
			(listings ? `, ${result.variants} listings (${result.mapped} newly mapped)` : "") +
			` in ${seconds}s`,
	);
	for (const problem of result.problems) console.log(`  ${problem}`);
}

if (!values.watch) {
	await pass();
	process.exit(0);
}
for (;;) {
	try {
		await pass();
	} catch (error) {
		// Keep watching through a bad pass (network blip, Shopify outage).
		console.error(`${new Date().toISOString()} sync failed:`, error);
	}
	await new Promise((resolve) => setTimeout(resolve, ORDER_EVERY));
}
