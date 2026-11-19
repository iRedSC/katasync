ALTER TABLE "orders" ADD COLUMN "pickup" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ready_for_pickup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_fulfillment_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_ready_is_pickup" CHECK ("orders"."ready_for_pickup_at" is null or "orders"."pickup");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_picked_up_is_pickup" CHECK ("orders"."pickup_fulfillment_id" is null or "orders"."pickup");