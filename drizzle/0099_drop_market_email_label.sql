-- The app before folders, which needed label and folder's default, is gone;
-- the one serving now writes folder itself.
ALTER TABLE "market_emails" ALTER COLUMN "folder" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "market_emails" DROP COLUMN "label";--> statement-breakpoint
DROP TYPE "public"."market_email_label";