ALTER TABLE "listings" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "product_type" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "vendor" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "status" text;