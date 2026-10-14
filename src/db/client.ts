import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";
import * as schema from "./schema";

// Works for both node-postgres in the app and PGlite in tests.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let db: Db | undefined;

export function getDb(): Db {
	if (!db) {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error("DATABASE_URL is not set");
		db = drizzle(new Pool({ connectionString, max: 10 }), {
			schema,
			casing: "snake_case",
		});
	}
	return db;
}

// A connection of its own, closed afterwards. For running SQL we don't write:
// whatever it changes on the session (set_config, advisory locks) goes away
// with the connection instead of reaching the shared pool.
export async function withOwnConnection<T>(
	use: (db: Db) => Promise<T>,
	connectionString = process.env.DATABASE_URL,
): Promise<T> {
	if (!connectionString) throw new Error("DATABASE_URL is not set");
	const client = new Client({ connectionString });
	// A dropped connection fails its next query instead of crashing the
	// process with an unhandled error event.
	client.on("error", () => {});
	await client.connect();
	try {
		return await use(drizzle(client, { schema, casing: "snake_case" }));
	} finally {
		await client.end();
	}
}
