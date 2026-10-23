// Imports a Sumtracker export into an empty database.
//
//   pnpm import:sumtracker --products products.csv --bundles bundles.csv --stock stock-levels.csv
//
// Prints the plan and its warnings. Add --apply to write it.
import { actAsScript } from "#/audit/script";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getDb } from "#/db/client";
import {
	applySumtrackerImport,
	planSumtrackerImport,
} from "#/import/sumtracker";

actAsScript("import-sumtracker");

const { values } = parseArgs({
	options: {
		products: { type: "string" },
		bundles: { type: "string" },
		stock: { type: "string" },
		location: { type: "string", default: "Warehouse" },
		apply: { type: "boolean", default: false },
	},
});
if (!values.products || !values.bundles || !values.stock) {
	throw new Error("Pass --products, --bundles, and --stock");
}

const plan = planSumtrackerImport({
	products: readFileSync(values.products, "utf8"),
	bundles: readFileSync(values.bundles, "utf8"),
	stock: readFileSync(values.stock, "utf8"),
});

console.log(`Products:       ${plan.products.length}`);
console.log(`  bundles:      ${plan.recipes.size}`);
console.log(`Variant groups: ${plan.groups.length}`);
console.log(`Amazon aliases: ${plan.aliases.length}`);
console.log(
	`Stock lines:    ${plan.openingStock.length} (into "${values.location}")`,
);
console.log(`\nWarnings (${plan.warnings.length}):`);
for (const w of plan.warnings) console.log(`  ${w}`);

if (!values.apply) {
	console.log("\nDry run. Add --apply to write this to the database.");
} else {
	try {
		process.loadEnvFile(".env.local");
	} catch {
		// No .env.local; rely on the real environment.
	}
	const result = await applySumtrackerImport(getDb(), plan, values.location);
	console.log("\nImported:", result);
	process.exit(0);
}
