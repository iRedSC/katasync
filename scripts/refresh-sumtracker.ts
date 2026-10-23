// Cutover: starts stock over from a fresh Sumtracker export on a database
// that's already in use (see src/import/refresh.ts). Turn Sumtracker's
// syncing off first, export, then run this right away.
//
//   pnpm import:refresh --products products.csv --bundles bundles.csv \
//     --stock stock-levels.csv --exported-at 2026-10-20T14:05:00-04:00 \
//     --unlimited DM-T-100,TT-10BK --count DURA-51,DURA-56
//
// Prints the plan. Add --apply to write it.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { actAsScript } from "#/audit/script";
import { getDb } from "#/db/client";
import { refreshFromSumtracker } from "#/import/refresh";
import { planSumtrackerImport } from "#/import/sumtracker";

actAsScript("refresh-sumtracker");

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const { values } = parseArgs({
	options: {
		products: { type: "string" },
		bundles: { type: "string" },
		stock: { type: "string" },
		"exported-at": { type: "string" },
		unlimited: { type: "string", default: "" },
		count: { type: "string", default: "" },
		apply: { type: "boolean", default: false },
	},
});
if (!values.products || !values.bundles || !values.stock)
	throw new Error("Pass --products, --bundles, and --stock");
// Required, and with its zone: a wrong time takes sales twice or not at all.
const at = values["exported-at"];
if (!at || !/(Z|[+-]\d\d:\d\d)$/.test(at))
	throw new Error(
		"Pass --exported-at with a time zone, e.g. 2026-10-20T14:05:00-04:00",
	);
const exportedAt = new Date(at);
if (Number.isNaN(exportedAt.getTime()))
	throw new Error(`--exported-at isn't a time: ${at}`);
const list = (s: string) =>
	s
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);

const plan = planSumtrackerImport({
	products: readFileSync(values.products, "utf8"),
	bundles: readFileSync(values.bundles, "utf8"),
	stock: readFileSync(values.stock, "utf8"),
});
const units = plan.shelves.reduce((n, s) => n + s.inStock - s.booked, 0);
const booked = plan.shelves.reduce((n, s) => n + s.booked, 0);
console.log(`Products in the export: ${plan.products.length}`);
console.log(
	`Opening stock:          ${plan.shelves.length} products, ${units} units (on the shelf less ${booked} booked)`,
);
console.log(`Exported at:            ${exportedAt.toISOString()}`);
console.log(`\nWarnings (${plan.warnings.length}):`);
for (const w of plan.warnings) console.log(`  ${w}`);

if (!values.apply) {
	console.log(
		"\nDry run. --apply wipes stock, counts, and every PO, then starts over from this export.",
	);
	process.exit(0);
}
const result = await refreshFromSumtracker(getDb(), plan, {
	exportedAt,
	unlimited: list(values.unlimited),
	countFirst: list(values.count),
});
console.log(`\nUpdated ${result.updated} products.`);
console.log(`Added ${result.added.length}: ${result.added.join(", ")}`);
console.log(
	`Left alone (katasync only, no stock until a pull): ${result.untouched.length}`,
);
console.log(`Sales since the export taken again: ${result.salesRetaken}`);
if (result.problems.length > 0) {
	console.log(`\nProblems (${result.problems.length}):`);
	for (const p of result.problems) console.log(`  ${p}`);
}
console.log("\nNext: pnpm stock:pull, then preview the push.");
process.exit(0);
