ALTER TABLE "dispatch_orders" ADD COLUMN "channel_first_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD COLUMN "channel_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD COLUMN "channel_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "signature" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "dispatch_orders_retry_idx" ON "dispatch_orders" USING btree ("channel_retry_at");