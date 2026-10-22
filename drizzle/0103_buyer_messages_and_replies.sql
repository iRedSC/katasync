CREATE TYPE "public"."buyer_reply_status" AS ENUM('sending', 'sent', 'delivered', 'failed', 'unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."reply_draft_state" AS ENUM('drafting', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "buyer_message_checks" (
	"market" "channel" PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone,
	"read_through" timestamp with time zone,
	"error" text,
	"errored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "buyer_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buyer_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"thread_id" integer NOT NULL,
	"from_buyer" boolean NOT NULL,
	"external_id" text,
	"body" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"market_email_id" integer,
	"in_reply_to" text,
	"refused_by" integer,
	"language" text,
	"english" text,
	"status" "buyer_reply_status",
	"request_key" uuid,
	"error" text,
	"status_at" timestamp with time zone,
	CONSTRAINT "buyer_messages_status_is_ours" CHECK ("buyer_messages"."from_buyer" = ("buyer_messages"."status" is null)),
	CONSTRAINT "buyer_messages_ours_have_key" CHECK ("buyer_messages"."from_buyer" or ("buyer_messages"."request_key" is not null and "buyer_messages"."status_at" is not null)),
	CONSTRAINT "buyer_messages_theirs_have_id" CHECK (not "buyer_messages"."from_buyer" or "buyer_messages"."external_id" is not null),
	CONSTRAINT "buyer_messages_gone_has_id" CHECK ("buyer_messages"."status" is null or "buyer_messages"."status" not in ('sent', 'delivered') or "buyer_messages"."external_id" is not null),
	CONSTRAINT "buyer_messages_failed_says_why" CHECK (("buyer_messages"."status" in ('failed', 'unconfirmed')) = ("buyer_messages"."error" is not null))
);
--> statement-breakpoint
CREATE TABLE "buyer_threads" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buyer_threads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"market" "channel" NOT NULL,
	"external_id" text NOT NULL,
	"buyer_name" text,
	"subject" text NOT NULL,
	"order_ref" text,
	"item_ref" text,
	"read_latest_id" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_threads_market_external_id" UNIQUE("market","external_id")
);
--> statement-breakpoint
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
ALTER TABLE "mailbox_checks" ADD COLUMN "swept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "buyer_messages" ADD CONSTRAINT "buyer_messages_thread_id_buyer_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."buyer_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_messages" ADD CONSTRAINT "buyer_messages_market_email_id_market_emails_id_fk" FOREIGN KEY ("market_email_id") REFERENCES "public"."market_emails"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_messages" ADD CONSTRAINT "buyer_messages_refused_by_market_emails_id_fk" FOREIGN KEY ("refused_by") REFERENCES "public"."market_emails"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_thread_id_buyer_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."buyer_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_for_message_id_buyer_messages_id_fk" FOREIGN KEY ("for_message_id") REFERENCES "public"."buyer_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_messages_thread_external_id" ON "buyer_messages" USING btree ("thread_id","external_id") WHERE "buyer_messages"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_messages_request_key" ON "buyer_messages" USING btree ("request_key") WHERE "buyer_messages"."request_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_messages_market_email" ON "buyer_messages" USING btree ("market_email_id") WHERE "buyer_messages"."market_email_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_messages_refused_by" ON "buyer_messages" USING btree ("refused_by") WHERE "buyer_messages"."refused_by" is not null;--> statement-breakpoint
CREATE INDEX "buyer_messages_thread_at_idx" ON "buyer_messages" USING btree ("thread_id","at");--> statement-breakpoint
CREATE INDEX "buyer_messages_unsettled_idx" ON "buyer_messages" USING btree ("status") WHERE "buyer_messages"."status" in ('sending', 'sent', 'unconfirmed');--> statement-breakpoint
-- The read-only MCP role sees them like every other table.
GRANT SELECT ON "buyer_threads", "buyer_messages", "buyer_message_checks", "reply_precedents", "reply_drafts" TO katasync_mcp;
