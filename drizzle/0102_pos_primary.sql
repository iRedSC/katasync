ALTER TABLE "locations" ADD COLUMN "pos_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_one_pos_primary" ON "locations" USING btree ("pos_primary") WHERE "locations"."pos_primary";--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_pos_primary_ours" CHECK (not "locations"."pos_primary" or "locations"."kind" in ('owned', 'retail'));--> statement-breakpoint
-- POS sales start on the warehouse: the store hasn't moved its stock to
-- Retail yet. Flipped to Retail from Settings on switchover day.
UPDATE "locations" SET "pos_primary" = true WHERE "id" = (SELECT "id" FROM "locations" WHERE "kind" = 'owned' ORDER BY "id" LIMIT 1);
