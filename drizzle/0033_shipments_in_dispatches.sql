ALTER TABLE "shipments" DROP CONSTRAINT "shipments_order_id_orders_id_fk";
--> statement-breakpoint
DROP INDEX "shipments_order_idx";--> statement-breakpoint
DROP INDEX "shipments_contents_idx";--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "dispatch_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_dispatch_idx" ON "shipments" USING btree ("dispatch_id");--> statement-breakpoint
ALTER TABLE "shipments" DROP COLUMN "order_id";--> statement-breakpoint
ALTER TABLE "shipments" DROP COLUMN "contents_key";--> statement-breakpoint
ALTER TABLE "shipments" DROP COLUMN "channel_sent_at";--> statement-breakpoint
ALTER TABLE "shipments" DROP COLUMN "channel_fulfillment_id";--> statement-breakpoint
ALTER TABLE "shipments" DROP COLUMN "channel_error";
