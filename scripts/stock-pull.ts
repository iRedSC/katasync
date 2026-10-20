// Takes the channels' quantities as opening stock for every product katasync
// has no stock record for (see src/stock-push/pull.ts). Run once, right after
// a sync pass and before turning stock push on, against the database you'll
// push from. Without --write it only lists what it would take.
//
//   pnpm stock:pull           # preview
//   pnpm stock:pull --write
import { isSyncedChannel } from "#/channels/sync";
import { getDb } from "#/db/client";
import { stockChannels } from "#/stock-push/channels";
import {
	applyStockPull,
	planStockPull,
	type StoreRead,
	storesInTrustOrder,
} from "#/stock-push/pull";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const write = process.argv.includes("--write");
const db = getDb();
const reads: StoreRead[] = [];
for (const store of await storesInTrustOrder(db)) {
	if (!isSyncedChannel(store.channel)) continue;
	try {
		reads.push({
			storeId: store.id,
			store: store.name,
			found: await stockChannels[store.channel].read(),
		});
	} catch (error) {
		// One channel down shouldn't hide the rest; its products fall to the
		// next store, so say so loudly.
		console.error(`Couldn't read ${store.name}, skipping it: ${error}`);
	}
}

// With no store read, every product would look unreported, which reads like
// a result rather than the failure it is.
if (reads.length === 0) {
	console.error("Couldn't read any store, so nothing to pull from.");
	process.exit(1);
}
const plan = await planStockPull(db, reads);
for (const p of plan.pulls)
	console.log(
		`${p.sku.padEnd(24)} ${String(p.quantity).padStart(5)}  from ${p.store}${p.disagreed ? " (its listings disagreed; took the lowest)" : ""}`,
	);
const units = plan.pulls.reduce((n, p) => n + p.quantity, 0);
console.log(
	`\n${plan.pulls.length} products, ${units} units, from ${reads.map((r) => r.store).join(" then ")}.`,
);
if (plan.unpulled.length > 0) {
	console.log(`\n${plan.unpulled.length} stockless products with no usable number:`);
	for (const u of plan.unpulled)
		console.log(`  ${u.sku.padEnd(24)} ${u.why}: ${u.detail}`);
}
if (write) {
	const posted = await applyStockPull(db, plan);
	console.log(`\nPosted opening stock for ${posted} products.`);
} else console.log("\nPreview only; run with --write to post it.");
process.exit(0);
