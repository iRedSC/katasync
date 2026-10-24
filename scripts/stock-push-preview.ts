import { eq } from "drizzle-orm";
import { actAsScript } from "#/audit/script";
import { isSyncedChannel } from "#/channels/sync";
import { getDb } from "#/db/client";
import { stores } from "#/db/schema";
import { stockChannels } from "#/stock-push/channels";
import { pushStoreStock } from "#/stock-push/push";

actAsScript("stock-push-preview");

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
	store,
	stockChannels[channel],
	"preview",
	new Date(),
	undefined,
	true,
);
for (const c of result.changes)
	console.log(
		`BLOCKED ${c.sku.padEnd(24)} ${String(c.from ?? "?").padStart(6)} -> ${c.to}`,
	);
console.log(
	`\n${result.changes.length} differences on ${store.name}; ${result.blocked} addressable listings blocked. No remote writes.`,
);
const problems = result.problems.filter((p) => !p.includes("preview only"));
if (problems.length > 0) {
	console.log(`\n${problems.length} problems:`);
	for (const p of problems) console.log(`  ${p}`);
}
process.exit(0);
