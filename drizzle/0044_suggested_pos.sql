ALTER TYPE "public"."purchase_order_status" ADD VALUE 'suggested' BEFORE 'draft';--> statement-breakpoint
DROP INDEX "purchase_orders_one_draft";--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_one_draft" ON "purchase_orders" USING btree ("supplier_id") WHERE "purchase_orders"."status" not in ('sent', 'closed', 'cancelled');