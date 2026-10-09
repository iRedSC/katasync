ALTER TABLE "shipments" ADD COLUMN "tracking_url" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "channel_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "channel_fulfillment_id" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "channel_error" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "refund_status" text;