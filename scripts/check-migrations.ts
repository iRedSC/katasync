// Drizzle applies a migration only when it's newer than the newest one the
// database has, by the `when` in drizzle/meta/_journal.json. One older than
// that is skipped without a word, and its schema never arrives. That
// happens when branches merge in a different order than their migrations
// were made, or when one branch migrates the shared dev database before
// another.
//
//   node scripts/check-migrations.ts   check the journal is in time order
//                                      (the hook and CI run this)
//
// `pnpm db:migrate` (scripts/migrate.ts) also checks against the database.
//
// Runs on Node's own type stripping, so it imports nothing but node: modules.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type JournalEntry = { idx: number; tag: string; when: number };

// Each entry must come after the one before it, in place and in time.
export function journalProblems(entries: JournalEntry[]): string[] {
	const problems: string[] = [];
	entries.forEach((e, i) => {
		if (e.idx !== i) problems.push(`${e.tag} is at position ${i} but says idx ${e.idx}`);
		const before = entries[i - 1];
		if (before && e.when <= before.when)
			problems.push(
				`${e.tag} is dated before ${before.tag}, so a database that has ${before.tag} skips it`,
			);
	});
	return problems;
}

export type Migration = { tag: string; when: number; hash: string };
export type Applied = { hash: string; createdAt: number };

// Migrations the database lacks that drizzle won't apply: dated at or before
// the newest one it has. An applied migration edited since shows up here too,
// since its contents no longer match.
export function skippedMigrations(local: Migration[], applied: Applied[]) {
	if (applied.length === 0) return [];
	const newest = Math.max(...applied.map((a) => a.createdAt));
	const have = new Set(applied.map((a) => a.hash));
	return local.filter((m) => !have.has(m.hash) && m.when <= newest);
}

export const FIX =
	"Give it a new number after the last migration and a `when` of now (Date.now()) in drizzle/meta/_journal.json, renaming its .sql and snapshot to match.";

// Run directly (not imported by the tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
	const problems = journalProblems(journal.entries);
	if (problems.length > 0) {
		process.stderr.write(
			`Migrations out of order:\n${problems.map((p) => `  ${p}`).join("\n")}\n${FIX}\n`,
		);
		process.exit(1);
	}
}
