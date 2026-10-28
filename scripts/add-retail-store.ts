// Adds our retail store as a location and makes it the one Shopify POS sales
// take stock from; stock moves between it and the warehouse with Move stock.
// In-store sales that came in before it existed (and so took no stock) take
// it now, and any that can't make the script exit nonzero. Without --write it
// only says what it would do.
//
//   pnpm location:add-retail            # preview, named "Retail"
//   pnpm location:add-retail --write
//   pnpm location:add-retail "Other name" --write

import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { actAsScript } from "#/audit/script";
import { getDb } from "#/db/client";
import { locations, orderLines, orders } from "#/db/schema";
import { addRetailStore, PosLocationError } from "#/inventory/locations";
import { applyStoreSales } from "#/orders/remap";

actAsScript("add-retail-store");

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const name = args.find((a) => a !== "--write")?.trim() || "Retail";

const db = getDb();
const [retail] = await db
	.select({ name: locations.name })
	.from(locations)
	.where(eq(locations.kind, "retail"));
if (retail) {
	// A second one would leave POS sales unsure which shelf to take from.
	console.error(`${retail.name} is already the retail store. Nothing added.`);
	process.exit(1);
}
const [taken] = await db
	.select({ id: locations.id })
	.from(locations)
	.where(eq(locations.name, name));
if (taken) {
	console.error(`There's already a location called ${name}. Nothing added.`);
	process.exit(1);
}

// Lines on in-store sales still waiting to take stock. Ones before the
// store's stock date never will, which applyStoreSales works out.
const [{ waiting }] = await db
	.select({ waiting: sql<number>`count(*)::int` })
	.from(orderLines)
	.innerJoin(orders, eq(orders.id, orderLines.orderId))
	.where(
		and(
			eq(orders.soldInStore, true),
			isNotNull(orderLines.productId),
			isNull(orderLines.saleBatchId),
			gt(orderLines.quantity, 0),
		),
	);

if (!write) {
	console.log(
		`Would add ${name} as the retail store POS sales take from, then take stock for in-store sales that haven't (up to ${waiting} lines, from the store's stock date on). Run again with --write.`,
	);
	process.exit(0);
}

try {
	await addRetailStore(db, name);
} catch (error) {
	// Someone added one since the checks above.
	if (!(error instanceof PosLocationError)) throw error;
	console.error(`${error.message}. Nothing added.`);
	process.exit(1);
}
const caught = await applyStoreSales(db);
console.log(
	`Added ${name}; POS sales take from it. ${caught.lines} in-store sale lines took stock from it.`,
);
for (const p of caught.problems) console.error(`  ${p}`);
console.log(
	`Its shelf starts empty: move stock to it from the product page, or count it there.`,
);
if (caught.problems.length > 0) console.error("The sales above took no stock.");
process.exit(caught.problems.length > 0 ? 1 : 0);
