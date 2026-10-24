// Marks products as not counted: they sell without limit on every channel
// until their first shelf count (see src/inventory/not-counted.ts). Without
// --write it only lists what it would mark.
//
//   pnpm stock:not-counted DM-T-100 TT-10BK           # preview
//   pnpm stock:not-counted DM-T-100 TT-10BK --write

import { inArray } from "drizzle-orm";
import { actAsScript } from "#/audit/script";
import { getDb } from "#/db/client";
import { products } from "#/db/schema";
import { markNotCounted } from "#/inventory/not-counted";

actAsScript("mark-not-counted");

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const skus = [...new Set(args.filter((a) => a !== "--write"))];
if (skus.length === 0) {
	console.error("Name the SKUs to mark.");
	process.exit(1);
}

const db = getDb();
const found = await db
	.select({
		id: products.id,
		sku: products.sku,
		kind: products.kind,
		since: products.notCountedSince,
	})
	.from(products)
	.where(inArray(products.sku, skus));
const missing = skus.filter((s) => !found.some((p) => p.sku === s));
if (missing.length > 0) {
	// A typo would silently leave a product at 0 on every channel.
	console.error(`No product for: ${missing.join(", ")}. Nothing marked.`);
	process.exit(1);
}
for (const p of found)
	console.log(
		`${p.sku.padEnd(24)} ${p.kind === "bundle" ? "tool set: mark its parts instead" : p.since ? "already not counted" : "will be marked"}`,
	);
if (write) {
	const marked = await markNotCounted(
		db,
		found.map((p) => p.id),
	);
	console.log(`\nMarked ${marked} products not counted.`);
} else console.log("\nPreview only; run with --write to mark them.");
process.exit(0);
