import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";
import { FIX, skippedMigrations } from "./check-migrations.ts";

type Connection = {
	query(sql: string, parameters?: unknown[]): Promise<{ rows: unknown[] }>;
};

// Enum additions must commit before a later migration can use their values.
export async function migrateDatabase(
	connection: Connection,
	migrations: MigrationMeta[] = readMigrationFiles({
		migrationsFolder: "drizzle",
	}),
) {
	await connection.query("SELECT pg_advisory_lock(1792958027)");
	try {
		await connection.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
		await connection.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
			id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
		const applied = await connection.query(
			"SELECT hash, created_at FROM drizzle.__drizzle_migrations",
		);
		const rows = applied.rows as {
			hash: string;
			created_at: string | number;
		}[];
		const skipped = skippedMigrations(
			migrations.map((migration) => ({
				tag: String(migration.folderMillis),
				when: migration.folderMillis,
				hash: migration.hash,
			})),
			rows.map((row) => ({
				hash: row.hash,
				createdAt: Number(row.created_at),
			})),
		);
		if (skipped.length)
			throw new Error(`Database would skip migrations. ${FIX}`);
		const have = new Set(rows.map((row) => row.hash));
		for (const migration of migrations) {
			if (have.has(migration.hash)) continue;
			await connection.query("BEGIN");
			try {
				for (const statement of migration.sql)
					await connection.query(statement);
				await connection.query(
					"INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
					[migration.hash, migration.folderMillis],
				);
				await connection.query("COMMIT");
			} catch (error) {
				await connection.query("ROLLBACK");
				throw error;
			}
		}
	} finally {
		await connection.query("SELECT pg_advisory_unlock(1792958027)");
	}
}
