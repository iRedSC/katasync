ALTER TABLE "mail_rules" ADD COLUMN "match" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_rules" ADD COLUMN "critical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "market_emails" ADD COLUMN "critical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_rules" ADD CONSTRAINT "mail_rules_match_known" CHECK ("mail_rules"."match" in ('all', 'any'));--> statement-breakpoint
ALTER TABLE "mail_rules" ADD CONSTRAINT "mail_rules_critical_is_important" CHECK (not "mail_rules"."critical" or "mail_rules"."important");--> statement-breakpoint
ALTER TABLE "market_emails" ADD CONSTRAINT "market_emails_critical_is_important" CHECK (not "market_emails"."critical" or "market_emails"."important");