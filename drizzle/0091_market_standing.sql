CREATE TABLE "market_standing" (
	"market" "channel" PRIMARY KEY NOT NULL,
	"standing" jsonb,
	"checked_at" timestamp with time zone,
	"error" text,
	"errored_at" timestamp with time zone
);
--> statement-breakpoint
-- The read-only MCP role sees standing like every other table.
GRANT SELECT ON "market_standing" TO katasync_mcp;
