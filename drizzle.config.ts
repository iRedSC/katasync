import { defineConfig } from "drizzle-kit";

// `neon link` writes connection strings to .env.local.
try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/capability-schema.ts",
	out: "./drizzle",
	casing: "snake_case",
	// Migrations use the direct connection; the pooler doesn't suit DDL.
	dbCredentials: {
		url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
	},
});
