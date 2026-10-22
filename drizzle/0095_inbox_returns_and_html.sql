ALTER TYPE "public"."market_email_label" ADD VALUE IF NOT EXISTS 'returns' BEFORE 'updates';--> statement-breakpoint
ALTER TABLE "market_email_attachments" ADD COLUMN "content_id" text;--> statement-breakpoint
ALTER TABLE "market_emails" ADD COLUMN "body_html" text;--> statement-breakpoint
ALTER TABLE "po_email_attachments" ADD COLUMN "content_id" text;--> statement-breakpoint
ALTER TABLE "po_emails" ADD COLUMN "body_html" text;