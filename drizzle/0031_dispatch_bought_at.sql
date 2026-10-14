ALTER TABLE "dispatches" ADD COLUMN "bought_at" timestamp with time zone;--> statement-breakpoint
-- Every label before this was bought whole.
UPDATE "dispatches" SET "bought_at" = "created_at";
