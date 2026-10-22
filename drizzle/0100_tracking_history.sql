ALTER TABLE "purchase_order_tracking" ADD COLUMN "original_eta" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_order_tracking" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "purchase_order_tracking" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "purchase_order_tracking" ADD COLUMN "destination" text;--> statement-breakpoint
ALTER TABLE "purchase_order_tracking" ADD COLUMN "history" jsonb DEFAULT '[]'::jsonb NOT NULL;