CREATE TYPE "public"."market_email_label" AS ENUM('attention', 'orders', 'updates');--> statement-breakpoint
CREATE TABLE "mailbox_checks" (
	"mailbox" text PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone,
	"error" text,
	"errored_at" timestamp with time zone,
	CONSTRAINT "mailbox_checks_known" CHECK ("mailbox_checks"."mailbox" in ('purchasing', 'marketplaces'))
);
--> statement-breakpoint
CREATE TABLE "market_email_attachments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "market_email_attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email_id" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea"
);
--> statement-breakpoint
CREATE TABLE "market_emails" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "market_emails_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" text NOT NULL,
	"market" "channel",
	"label" "market_email_label" NOT NULL,
	"relabelled_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"from_address" text NOT NULL,
	"from_name" text,
	"recipients" text[] NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_email_attachments" ADD CONSTRAINT "market_email_attachments_email_id_market_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."market_emails"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_email_attachments_email_idx" ON "market_email_attachments" USING btree ("email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "market_emails_message_id" ON "market_emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "market_emails_open_idx" ON "market_emails" USING btree ("label","received_at") WHERE "market_emails"."done_at" is null;--> statement-breakpoint
-- The read-only MCP role sees them like every other table.
GRANT SELECT ON "market_emails", "market_email_attachments", "mailbox_checks" TO katasync_mcp;
