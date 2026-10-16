-- Every unit so far holds what the supplier counts in it, so the count starts
-- as the pack size and nothing printed changes.
ALTER TABLE "product_suppliers" DROP CONSTRAINT "product_suppliers_each_is_one";--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "supplier_count" integer;--> statement-breakpoint
UPDATE "product_suppliers" SET "supplier_count" = "pack_size";--> statement-breakpoint
ALTER TABLE "product_suppliers" ALTER COLUMN "supplier_count" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "supplier_count" integer;--> statement-breakpoint
UPDATE "purchase_order_lines" SET "supplier_count" = "pack_size";--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "supplier_count" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_supplier_count_positive" CHECK ("product_suppliers"."supplier_count" > 0);--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_each_is_one" CHECK ("product_suppliers"."unit" <> 'EACH' or ("product_suppliers"."pack_size" = 1 and "product_suppliers"."supplier_count" = 1));--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_supplier_count_positive" CHECK ("purchase_order_lines"."supplier_count" > 0);
