// Prints a one-time link that adds a device for a named owner: the first
// owner, or one who lost every device. Someone with that name is made an
// active owner if they aren't one. Running it needs the database, which is
// what makes it safe.
//
//   pnpm auth:setup-link "Sam Rivera"

import { audited } from "#/audit/audited-db";
import { runAs } from "#/audit/context";
import { appOrigin } from "#/auth/origin";
import { recoverOwner } from "#/auth/staff";
import { getDb } from "#/db/client";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const origin = appOrigin();
const name = process.argv.slice(2).join(" ");
if (!name.trim())
	throw new Error('Give the owner\'s name: pnpm auth:setup-link "Sam Rivera"');
const minutes = 30;
const actor = { kind: "system", name: "recovery-script" } as const;
const made = await runAs(actor, "auth:setup-link", () =>
	recoverOwner(audited(getDb()), actor, name, { minutes }),
);
const what = {
	created: `Made ${name} an owner.`,
	reinstated: `${name} is an active owner again.`,
	unchanged: `${name} is already an owner.`,
}[made.outcome];
console.log(
	`${what} Open this on their device within ${minutes} minutes:\n\n${origin}/setup?token=${made.token}\n`,
);
process.exit(0);
