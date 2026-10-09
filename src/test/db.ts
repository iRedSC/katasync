import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";

// Migrating takes about a second, so do it once per test file and hand each
// test a fresh clone.
let migrated: Promise<PGlite> | undefined;

export async function createTestDb(): Promise<Db> {
	migrated ??= (async () => {
		const pg = new PGlite();
		await migrate(drizzle(pg, { casing: "snake_case" }), {
			migrationsFolder: "drizzle",
		});
		return pg;
	})();
	const clone = (await (await migrated).clone()) as PGlite;
	return drizzle(clone, { schema, casing: "snake_case" });
}

export async function createProduct(
	db: Db,
	code: string,
	kind: "simple" | "kit" | "bundle",
) {
	const [row] = await db
		.insert(schema.products)
		.values({ sku: code, name: code, kind })
		.returning();
	return row.id;
}
