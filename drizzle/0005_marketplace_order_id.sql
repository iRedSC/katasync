ALTER TABLE "orders" ADD COLUMN "marketplace_order_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_marketplaceOrderId_unique" UNIQUE("marketplace_order_id");