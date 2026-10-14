CREATE TABLE "mcp_login" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"password" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_login_single" CHECK ("mcp_login"."id" = 1)
);
--> statement-breakpoint
-- The MCP query tool connects as katasync_mcp, which can read every table
-- except the secret ones (SECRET_TABLES in src/mcp/query.ts). Postgres
-- enforces that, so no trick in the query text gets around it. Tables made
-- later are readable too, by default; a new secret table needs a REVOKE in its
-- migration and its name in SECRET_TABLES.
DO $$ BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'katasync_mcp') THEN
		CREATE ROLE katasync_mcp LOGIN;
	END IF;
END $$;--> statement-breakpoint
ALTER ROLE katasync_mcp SET statement_timeout = '15s';--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO katasync_mcp;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO katasync_mcp;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO katasync_mcp;--> statement-breakpoint
REVOKE ALL ON "sessions", "passkeys", "api_tokens", "setup_links", "auth_challenges", "mcp_login" FROM katasync_mcp;
