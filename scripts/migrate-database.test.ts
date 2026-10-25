import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";
import { migrateDatabase } from "./migrate-database";

test("each migration commits separately and a failed migration rolls back and resumes", async () => {
	const pg = new PGlite();
	const first = {
		sql: ["CREATE TYPE test_stage AS ENUM ('old')"],
		hash: "first",
		folderMillis: 1,
		bps: true,
	};
	const second = {
		sql: ["ALTER TYPE test_stage ADD VALUE 'new'"],
		hash: "second",
		folderMillis: 2,
		bps: true,
	};
	const third = {
		sql: [
			"CREATE TABLE test_cases (status test_stage)",
			"INSERT INTO test_cases VALUES ('new')",
		],
		hash: "third",
		folderMillis: 3,
		bps: true,
	};
	const failure = {
		sql: ["CREATE TABLE failed (id integer)", "SELECT missing_column"],
		hash: "failure",
		folderMillis: 4,
		bps: true,
	};
	try {
		await expect(
			migrateDatabase(pg, [first, second, third, failure]),
		).rejects.toThrow();
		expect((await pg.query("SELECT status FROM test_cases")).rows).toEqual([
			{ status: "new" },
		]);
		expect(
			(await pg.query("SELECT to_regclass('failed') AS name")).rows,
		).toEqual([{ name: null }]);
		expect(
			(
				await pg.query(
					"SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
				)
			).rows,
		).toEqual([{ hash: "first" }, { hash: "second" }, { hash: "third" }]);
		await migrateDatabase(pg, [
			first,
			second,
			third,
			{ ...failure, sql: ["CREATE TABLE failed (id integer)"] },
		]);
		expect(
			(
				await pg.query(
					"SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
				)
			).rows,
		).toEqual([{ count: 4 }]);
		await expect(
			migrateDatabase(pg, [{ ...first, hash: "edited" }, second, third]),
		).rejects.toThrow("Database would skip");
	} finally {
		await pg.close();
	}
});
