// Drizzle applies a migration only when it's newer than the newest one the
// database has, by the `when` in drizzle/meta/_journal.json. One older than
// that is skipped without a word, and its schema never arrives. That
// happens when branches merge in a different order than their migrations
// were made, or when one branch migrates the shared dev database before
// another.
//
//   node scripts/check-migrations.ts   check the journal is in time order
//                                      (the hook and CI run this)
//   node scripts/check-migrations.ts --against origin/main
//                                      also check no migration main has was
//                                      edited, moved, or removed (CI runs this)
//
// `pnpm db:migrate` (scripts/migrate.ts) also checks against the database.
//
// Runs on Node's own type stripping, so it imports nothing but node: modules.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type JournalEntry = { idx: number; tag: string; when: number };

// Each entry must come after the one before it, in place and in time.
export function journalProblems(entries: JournalEntry[]): string[] {
	const problems: string[] = [];
	entries.forEach((e, i) => {
		if (e.idx !== i)
			problems.push(`${e.tag} is at position ${i} but says idx ${e.idx}`);
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

// A migration on main has been applied to the database. Drizzle knows it by
// the hash of its SQL, so editing it later makes the deploy refuse (see
// scripts/migrate.ts), and moving or removing it does the same. Tests migrate
// a fresh database and can't see this; comparing with main can.
export type Recorded = { tag: string; when: number; sql: string };

export function historyProblems(base: Recorded[], head: Recorded[]): string[] {
	const now = new Map(head.map((m) => [m.tag, m]));
	return base.flatMap((m, i) => {
		const h = now.get(m.tag);
		if (!h)
			return [
				`${m.tag} was removed or renamed, but the database already has it`,
			];
		const problems: string[] = [];
		if (head[i]?.tag !== m.tag)
			problems.push(`${m.tag} moved from position ${i}`);
		if (h.when !== m.when) problems.push(`${m.tag} had its \`when\` changed`);
		if (h.sql !== m.sql)
			problems.push(`${m.tag} was edited after it was applied`);
		return problems;
	});
}

export const HISTORY_FIX =
	"Put the applied migration back as it was, and make the change in a new migration.";

export const FIX =
	"Give it a new number after the last migration and a `when` of now (Date.now()) in drizzle/meta/_journal.json, renaming its .sql and snapshot to match.";

// Run directly (not imported by the tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const journal = JSON.parse(
		readFileSync("drizzle/meta/_journal.json", "utf8"),
	);
	const problems = journalProblems(journal.entries);
	if (problems.length > 0) {
		process.stderr.write(
			`Migrations out of order:\n${problems.map((p) => `  ${p}`).join("\n")}\n${FIX}\n`,
		);
		process.exit(1);
	}

	const at = process.argv.indexOf("--against");
	if (at !== -1) {
		const ref = process.argv[at + 1];
		if (!ref) throw new Error("--against needs a git ref");
		const show = (path: string) =>
			execFileSync("git", ["show", `${ref}:${path}`], {
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			});
		const recorded = (
			entries: JournalEntry[],
			sqlOf: (tag: string) => string,
		): Recorded[] =>
			entries.map((e) => ({ tag: e.tag, when: e.when, sql: sqlOf(e.tag) }));
		const base = recorded(
			JSON.parse(show("drizzle/meta/_journal.json")).entries,
			(tag) => show(`drizzle/${tag}.sql`),
		);
		const head = recorded(journal.entries, (tag) =>
			readFileSync(`drizzle/${tag}.sql`, "utf8"),
		);
		const history = historyProblems(base, head);
		if (history.length > 0) {
			process.stderr.write(
				`Applied migrations changed since ${ref}:\n${history.map((p) => `  ${p}`).join("\n")}\n${HISTORY_FIX}\n`,
			);
			process.exit(1);
		}
	}
}
