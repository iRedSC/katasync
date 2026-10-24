// Sets products' costs from a cost list (src/import/costs.ts). Sales already
// made keep theirs. Save profit-margarine's Export Costs sheet as CSV first.
//
//   pnpm import:costs --costs product-costs.csv
//
// Prints the plan. Add --apply to write it.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { actAsScript } from "#/audit/script";
import { getDb } from "#/db/client";
import { applyCostImport, costCatalog, planCostImport } from "#/import/costs";

actAsScript("import-costs");

const { values } = parseArgs({
	options: {
		costs: { type: "string" },
		apply: { type: "boolean", default: false },
	},
});
if (!values.costs) throw new Error("Pass --costs");

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}
const db = getDb();
const { catalog, aliases } = await costCatalog(db);
const plan = planCostImport(
	readFileSync(values.costs, "utf8"),
	catalog,
	aliases,
);

const changed = plan.set.filter((c) => c.from !== c.to);
const money = (n: number | null) => (n === null ? "none" : `$${n}`);
console.log(`Costed:    ${plan.set.length} (${changed.length} change)`);
console.log(
	`Kept:      ${plan.clear.filter((c) => !c.bundle).length} (not in the list, or no cost there)`,
);
console.log(`Not here:  ${plan.unknown.length} costed SKUs match no product`);
console.log("\nBiggest changes:");
for (const c of [...changed]
	.sort(
		(a, b) => Math.abs(b.to - (b.from ?? 0)) - Math.abs(a.to - (a.from ?? 0)),
	)
	.slice(0, 15))
	console.log(`  ${c.sku}: ${money(c.from)} -> ${money(c.to)}`);
console.log(`\nWarnings (${plan.warnings.length}):`);
for (const w of plan.warnings) console.log(`  ${w}`);

if (!values.apply) {
	console.log("\nDry run. Add --apply to write this to the database.");
} else {
	console.log("\nImported:", await applyCostImport(db, plan));
}
process.exit(0);
