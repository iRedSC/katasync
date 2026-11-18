// One-time, after drizzle/0187: reads every Shopify order still on To ship
// again, so local pickups synced before katasync knew about them leave the
// packing queue now instead of whenever Shopify next changes them. Each is
// saved the way a webhook saves it. Safe to stop and run again. Without
// --write it only counts them.
//
//   pnpm pickup:backfill
//   pnpm pickup:backfill --write

import { and, eq } from "drizzle-orm";
import { actAsScript } from "#/audit/script";
import { ingestShopifyOrder } from "#/channels/shopify";
import { getDb } from "#/db/client";
import { orders, stores } from "#/db/schema";
import { needsShipping } from "#/orders/to-ship";

actAsScript("backfill-pickup");

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const write = process.argv.includes("--write");
const db = getDb();
const open = await db
	.select({ name: orders.name, externalId: orders.externalId })
	.from(orders)
	.innerJoin(stores, eq(stores.id, orders.storeId))
	.where(and(eq(stores.channel, "shopify"), needsShipping));
console.log(`${open.length} Shopify orders on To ship`);
if (!write) process.exit(0);

let failed = 0;
for (const o of open) {
	const result = await ingestShopifyOrder(db, o.externalId).catch(
		(error: unknown) => ({ kind: "error", error }),
	);
	if (result.kind === "retry" || result.kind === "error") {
		failed++;
		console.log(`${o.name}: ${JSON.stringify(result)}`);
	}
}
const pickups = await db.$count(
	orders,
	and(eq(orders.pickup, true), needsShipping),
);
console.log(`Done; ${pickups} pickups waiting, ${failed} not read`);
process.exit(0);
