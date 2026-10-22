CREATE TYPE "public"."market_email_folder" AS ENUM('orders', 'returns', 'violations', 'updates');--> statement-breakpoint
CREATE TABLE "mail_rules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"conditions" jsonb NOT NULL,
	"folder" "market_email_folder",
	"important" boolean DEFAULT false NOT NULL,
	"mark_read" boolean DEFAULT false NOT NULL,
	"by" text DEFAULT 'staff' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_rules_does_something" CHECK ("mail_rules"."folder" is not null or "mail_rules"."important" or "mail_rules"."mark_read"),
	CONSTRAINT "mail_rules_by_known" CHECK ("mail_rules"."by" in ('staff', 'claude')),
	CONSTRAINT "mail_rules_has_conditions" CHECK (jsonb_array_length("mail_rules"."conditions") > 0)
);
--> statement-breakpoint
DROP INDEX "market_emails_open_idx";--> statement-breakpoint
ALTER TABLE "market_emails" ALTER COLUMN "label" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "market_emails" ADD COLUMN "folder" "market_email_folder" DEFAULT 'updates' NOT NULL;--> statement-breakpoint
ALTER TABLE "market_emails" ADD COLUMN "important" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "market_emails" ADD COLUMN "importance_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "market_emails" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "po_emails" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "market_emails_open_idx" ON "market_emails" USING btree ("folder","received_at") WHERE "market_emails"."done_at" is null;--> statement-breakpoint
-- Needs attention was a folder; it's now important, in whichever folder.
-- label stays, optional, so the app before folders keeps reading and
-- writing while the deploy runs; a later migration drops it.
-- Someone who moved one to attention marked it important; its folder is the
-- rules' again. Violations are found here so they don't wait for a sweep's
-- re-sort; the rest of attention waits in Updates until then.
UPDATE "market_emails" SET
	"folder" = CASE
		WHEN "label" <> 'attention' THEN "label"::text::"market_email_folder"
		WHEN "subject" ~* '\m(violat|polic(y|ies)|infring|counterfeit|inauthentic|intellectual property|suppress|remov(ed|al)|suspend|deactivat|restrict|blocked|frozen|freez|reinstat|penalt|defect|account health|at risk|warning|appeal)' THEN 'violations'
		ELSE 'updates'
	END,
	"important" = "label" = 'attention',
	"importance_set_at" = CASE WHEN "label" = 'attention' THEN "relabelled_at" END,
	"relabelled_at" = CASE WHEN "label" = 'attention' THEN NULL ELSE "relabelled_at" END;--> statement-breakpoint
-- The sorting katasync did in code, as rules anyone can change. Order
-- notices are routine, so they arrive read.
INSERT INTO "mail_rules" ("position", "name", "conditions", "folder", "important", "mark_read") VALUES
	(10, 'Violations and account health', '[{"field": "subject", "has": ["violat*", "policy", "policies", "infring*", "counterfeit", "inauthentic", "intellectual property", "suppress*", "removed", "removal", "suspend*", "deactivat*", "restrict*", "blocked", "frozen", "freez*", "reinstat*", "penalt*", "defect*", "account health", "at risk", "warning", "appeal*"], "not": false}]'::jsonb, 'violations', true, false),
	(20, 'Disputes and claims', '[{"field": "subject", "has": ["dispute*", "chargeback*", "claim*", "a-to-z", "case", "unpaid item", "negative feedback"], "not": false}]'::jsonb, NULL, true, false),
	(30, 'Asks us to act', '[{"field": "subject", "has": ["action required", "act now", "verify", "verification", "activat*", "document request"], "not": false}]'::jsonb, NULL, true, false),
	(40, 'Returns and refunds', '[{"field": "subject", "has": ["return", "returns", "returned", "return request*", "refund*", "rma", "replacement"], "not": false}]'::jsonb, 'returns', false, false),
	(50, 'Orders and shipping', '[{"field": "subject", "has": ["order", "orders", "sold", "you made a sale", "ship", "shipped", "shipment", "shipping", "deliver*", "cancel*", "buyer message", "purchase"], "not": false}]'::jsonb, 'orders', false, true);--> statement-breakpoint
-- Mail from before there was unread was all seen on the page; only what
-- arrives from now on starts unread.
UPDATE "market_emails" SET "read_at" = "received_at";--> statement-breakpoint
UPDATE "po_emails" SET "read_at" = "received_at";--> statement-breakpoint
-- The read-only MCP role sees them like every other table.
GRANT SELECT ON "mail_rules" TO katasync_mcp;