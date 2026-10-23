ALTER TABLE "mail_rules" DROP CONSTRAINT "mail_rules_does_something";--> statement-breakpoint
ALTER TABLE "mail_rules" ADD COLUMN "mark_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_rules" ADD CONSTRAINT "mail_rules_does_something" CHECK ("mail_rules"."folder" is not null or "mail_rules"."important" or "mail_rules"."mark_read" or "mail_rules"."mark_done");--> statement-breakpoint
-- Buyer messages are read and answered in Buyers (Amazon's relayed email and
-- its copies of what was sent in Seller Central; eBay's, read from its
-- Message API), so their emails needn't wait on anyone in the mail.
INSERT INTO "mail_rules" ("position", "name", "match", "conditions", "folder", "important", "mark_read", "mark_done") VALUES
	(60, 'Buyer messages, answered in Buyers', 'all', '[{"field": "sender", "has": ["@marketplace.amazon.com", "@members.ebay.com"], "not": false}]'::jsonb, NULL, false, false, true),
	(70, 'Sent in Seller Central, kept in Buyers', 'all', '[{"field": "subject", "has": ["your e-mail to"], "not": false}, {"field": "market", "is": ["amazon"], "not": false}]'::jsonb, NULL, false, false, true);--> statement-breakpoint
UPDATE "market_emails" SET "done_at" = now(), "read_at" = coalesce("read_at", now())
WHERE "done_at" IS NULL AND (
	"id" IN (SELECT "market_email_id" FROM "buyer_messages" WHERE "market_email_id" IS NOT NULL)
	OR "from_address" ILIKE '%@members.ebay.com'
	OR ("market" = 'amazon' AND "subject" ILIKE 'your e-mail to%')
);
