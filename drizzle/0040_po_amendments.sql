ALTER TABLE "purchase_order_lines" DROP CONSTRAINT "purchase_order_lines_quantity_positive";--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "sent_quantity" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "sent_unit_cost" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" ADD COLUMN "quantity_before" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" ADD COLUMN "quantity_after" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_sent_cost_needs_sent" CHECK ("purchase_order_lines"."sent_unit_cost" is null or "purchase_order_lines"."sent_quantity" is not null);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_quantity_not_negative" CHECK ("purchase_order_lines"."quantity" >= 0);--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" ADD CONSTRAINT "purchase_order_receipts_quantity_change_whole" CHECK (("purchase_order_receipts"."quantity_before" is null) = ("purchase_order_receipts"."quantity_after" is null));--> statement-breakpoint
-- Until now nothing changed after sending, so what's on a sent PO is what was sent.
UPDATE "purchase_order_lines" l SET "sent_quantity" = l."quantity", "sent_unit_cost" = l."unit_cost" FROM "purchase_orders" po WHERE po."id" = l."purchase_order_id" AND po."sent_at" IS NOT NULL;
