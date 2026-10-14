-- IF NOT EXISTS: dev made this table under an earlier number, before
-- katasync_mcp existed.
CREATE TABLE IF NOT EXISTS "qz_certificate" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"certificate" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qz_certificate_single" CHECK ("qz_certificate"."id" = 1)
);
--> statement-breakpoint
-- Secret (SECRET_TABLES in src/mcp/query.ts). New tables aren't granted to
-- katasync_mcp anyway, but where this one already existed, 0027 granted it.
REVOKE ALL ON "qz_certificate" FROM katasync_mcp;
