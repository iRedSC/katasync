// Imports Sumtracker's suppliers and which supplier each product comes from.
// Run after the product import.
//
//   pnpm import:suppliers --suppliers suppliers.csv --links primary-suppliers.csv
//
// Prints the plan and its warnings. Add --apply to write it.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { actAsScript } from "#/audit/script";
import { getDb } from "#/db/client";
import { products } from "#/db/schema";
import {
	applySupplierImport,
	planSupplierImport,
} from "#/import/sumtracker-suppliers";

actAsScript("import-suppliers");

const { values } = parseArgs({
	options: {
		suppliers: { type: "string" },
		links: { type: "string" },
		apply: { type: "boolean", default: false },
	},
});
if (!values.suppliers || !values.links) {
	throw new Error("Pass --suppliers and --links");
}

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}
const db = getDb();
const catalog = new Map(
	(
		await db
			.select({
				sku: products.sku,
				kind: products.kind,
				unitCost: products.unitCost,
			})
			.from(products)
	).map(({ sku, ...p }) => [sku, p]),
);

const plan = planSupplierImport(
	{
		suppliers: readFileSync(values.suppliers, "utf8"),
		links: readFileSync(values.links, "utf8"),
	},
	catalog,
);

console.log(`Suppliers: ${plan.suppliers.length}`);
console.log(`Links:     ${plan.links.length}`);
console.log(`\nWarnings (${plan.warnings.length}):`);
for (const w of plan.warnings) console.log(`  ${w}`);

if (!values.apply) {
	console.log("\nDry run. Add --apply to write this to the database.");
} else {
	const result = await applySupplierImport(db, plan);
	console.log("\nImported:", result);
}
process.exit(0);
