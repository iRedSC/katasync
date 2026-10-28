ALTER TABLE "order_cost_checks" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
-- Asks that worked before this column: their check is the last that worked.
UPDATE "order_cost_checks" SET "answered_at" = "checked_at" WHERE "error" IS NULL;