ALTER TABLE "repairs" ADD COLUMN "position" double precision DEFAULT extract(epoch from now()) NOT NULL;--> statement-breakpoint
-- Queued as the board showed them: oldest in each column first.
UPDATE "repairs" SET "position" = extract(epoch from "status_changed_at");
