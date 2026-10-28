ALTER TYPE "public"."sync_feed" ADD VALUE 'listings' BEFORE 'returns';--> statement-breakpoint
ALTER TYPE "public"."sync_feed" ADD VALUE 'stock' BEFORE 'returns';--> statement-breakpoint
ALTER TABLE "feed_health" ADD COLUMN "excluded" integer DEFAULT 0 NOT NULL;