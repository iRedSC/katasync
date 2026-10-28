ALTER TABLE "market_emails" ADD COLUMN "sender_checked_at" timestamp with time zone;--> statement-breakpoint
-- Only a check can have vouched for one; the rest were never asked, since
-- the mailbox read didn't read headers, and a sweep goes back for them.
UPDATE "market_emails" SET "sender_checked_at" = "created_at" WHERE "sender_authenticated";
