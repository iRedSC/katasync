// `pnpm db:migrate`: drizzle-kit migrate, but first refuses when the
// database would skip a migration (see scripts/check-migrations.ts), so a
// skip fails here, and fails the deploy, instead of passing silently.
import { execFileSync } from "node:child_process";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Client } from "pg";
import { FIX, skippedMigrations } from "./check-migrations.ts";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const journal = (await import("../drizzle/meta/_journal.json", {
	with: { type: "json" },
})).default as { entries: { tag: string }[] };
const local = readMigrationFiles({ migrationsFolder: "drizzle" }).map(
	(m, i) => ({ tag: journal.entries[i].tag, when: m.folderMillis, hash: m.hash }),
);

const client = new Client({ connectionString: url });
await client.connect();
const applied = await client
	.query<{ hash: string; created_at: string }>(
		`select hash, created_at from drizzle.__drizzle_migrations`,
	)
	// No table yet: nothing applied, so nothing can be skipped.
	.then((r) => r.rows.map((a) => ({ hash: a.hash, createdAt: Number(a.created_at) })))
	.catch(() => []);
await client.end();

const skipped = skippedMigrations(local, applied);
if (skipped.length > 0) {
	process.stderr.write(
		`The database would skip ${skipped.map((m) => m.tag).join(", ")}: dated before the newest migration it has, or edited after it was applied.\n${FIX}\n`,
	);
	process.exit(1);
}

execFileSync("drizzle-kit", ["migrate"], { stdio: "inherit" });
