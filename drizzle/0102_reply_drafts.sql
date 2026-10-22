CREATE TYPE "public"."reply_draft_state" AS ENUM('drafting', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "reply_drafts" (
	"thread_id" integer PRIMARY KEY NOT NULL,
	"state" "reply_draft_state" NOT NULL,
	"body" text,
	"english" text,
	"for_message_id" integer,
	"by" text NOT NULL,
	"precedent_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"note" text,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_drafts_ready_has_body" CHECK ("reply_drafts"."state" <> 'ready' or "reply_drafts"."body" is not null),
	CONSTRAINT "reply_drafts_failed_says_why" CHECK (("reply_drafts"."state" = 'failed') = ("reply_drafts"."error" is not null)),
	CONSTRAINT "reply_drafts_by_known" CHECK ("reply_drafts"."by" in ('ai', 'staff', 'claude'))
);
--> statement-breakpoint
CREATE TABLE "reply_precedents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reply_precedents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"when" text NOT NULL,
	"then" text NOT NULL,
	"by" text DEFAULT 'staff' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buyer_messages" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "buyer_messages" ADD COLUMN "english" text;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_thread_id_buyer_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."buyer_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_for_message_id_buyer_messages_id_fk" FOREIGN KEY ("for_message_id") REFERENCES "public"."buyer_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The read-only MCP role sees them like every other table.
GRANT SELECT ON "reply_precedents", "reply_drafts" TO katasync_mcp;
