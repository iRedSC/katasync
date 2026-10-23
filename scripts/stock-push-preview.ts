// What stock push would set on one channel's store, without writing to it.
// Run it before turning a store on in Settings, against the database you'll
// push from, to check the numbers.
//
//   pnpm stock-push:preview shopify
//
// Reads the channel's quantities now (and saves what it read, as a push pass
// would), then lists every listing whose quantity would change and every
// listing katasync can't set.
import { eq } from "drizzle-orm";
import { isSyncedChannel } from "#/channels/sync";
import { getDb } from "#/db/client";
import { stores } from "#/db/schema";
import { stockChannels } from "#/stock-push/channels";
import { pushStoreStock } from "#/stock-push/push";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const channel = process.argv[2] ?? "";
if (!isSyncedChannel(channel)) {
	throw new Error(`Name a channel: ${Object.keys(stockChannels).join(", ")}`);
}
const db = getDb();
const [store] = await db
	.select()
	.from(stores)
	.where(eq(stores.channel, channel));
if (!store) throw new Error(`No ${channel} store yet; run pnpm sync first`);

// A null read time makes the pass read the channel now.
const result = await pushStoreStock(
	db,
	{ ...store, stockReadAt: null },
	stockChannels[channel],
	"preview",
);
for (const c of result.changes)
	console.log(
		`${c.sku.padEnd(24)} ${String(c.from ?? "?").padStart(6)} -> ${c.to}`,
	);
console.log(
	`\n${result.changes.length} listings would change on ${store.name}.`,
);
const problems = result.problems.filter((p) => !p.includes("preview only"));
if (problems.length > 0) {
	console.log(`\n${problems.length} problems:`);
	for (const p of problems) console.log(`  ${p}`);
}
process.exit(0);
