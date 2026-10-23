import { readFileSync } from "node:fs";
import { getDb } from "#/db/client";
import {
	ActivationBlocked,
	activateCommittedMode,
	planActivation,
	type Resolution,
} from "#/inventory/commitments-activation";
import { committedDrift, readQuantityMode } from "#/inventory/commitments";

try {
	process.loadEnvFile(".env.local");
} catch {}

const args = process.argv.slice(2);
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const file = flag("--resolutions");
const resolutions: Resolution[] = file
	? JSON.parse(readFileSync(file, "utf8"))
	: [];
const db = getDb();

console.log(`Mode: ${await readQuantityMode(db, "none")}`);
const plan = await planActivation(db, { resolutions });
console.log(
	`Convert ${plan.convert.length} open eager sale line(s) to reservations (${plan.convert.filter((l) => l.shipped > 0).length} partly shipped).`,
);
console.log(`Keep ${plan.keep.shipped} shipped and ${plan.keep.pos} POS line(s) as sold.`);
for (const u of plan.unresolved)
	console.log(
		`UNRESOLVED ${u.orderName} line ${u.orderLineId} qty ${u.quantity} ${u.fulfillmentStatus}: ${u.why}`,
	);
const drift = await committedDrift(db);
if (drift.length > 0) console.log(`Committed drift: ${JSON.stringify(drift)}`);
console.log(`Fingerprint: ${plan.fingerprint}`);

if (!args.includes("--write")) process.exit(plan.unresolved.length > 0 ? 2 : 0);
if (!args.includes("--old-workers-drained")) {
	console.error("Refusing: pass --old-workers-drained once the old deployment's crons and syncs are stopped.");
	process.exit(1);
}
const fingerprint = flag("--fingerprint");
if (!fingerprint) {
	console.error("Refusing: pass --fingerprint from the reviewed dry run.");
	process.exit(1);
}
try {
	const report = await activateCommittedMode(db, {
		fingerprint,
		resolutions,
		oldWorkersDrained: true,
	});
	console.log(`Activated: ${JSON.stringify(report)}`);
	process.exit(0);
} catch (error) {
	if (error instanceof ActivationBlocked) {
		console.error(error.message);
		process.exit(2);
	}
	throw error;
}
