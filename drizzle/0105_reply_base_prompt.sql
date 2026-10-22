CREATE TABLE "reply_base_prompt" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"prompt" text NOT NULL,
	"by" text DEFAULT 'staff' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_base_prompt_one_row" CHECK ("reply_base_prompt"."id" = 1),
	CONSTRAINT "reply_base_prompt_by_known" CHECK ("reply_base_prompt"."by" in ('staff', 'claude'))
);
--> statement-breakpoint
-- Precedents from before names are named by their when, to rename.
ALTER TABLE "reply_precedents" ADD COLUMN "name" text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE "reply_precedents" SET "name" = left("when", 60);--> statement-breakpoint
ALTER TABLE "reply_precedents" ALTER COLUMN "name" DROP DEFAULT;--> statement-breakpoint
-- The read-only MCP role sees it like every other table.
GRANT SELECT ON "reply_base_prompt" TO katasync_mcp;
