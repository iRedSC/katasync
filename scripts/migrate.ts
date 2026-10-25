import { Client } from "pg";
import { migrateDatabase } from "./migrate-database.ts";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const client = new Client({ connectionString: url });
await client.connect();
try {
	await migrateDatabase(client);
} finally {
	await client.end();
}
