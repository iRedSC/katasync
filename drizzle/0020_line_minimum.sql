ALTER TABLE "purchase_order_lines" ADD COLUMN "minimum_quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_minimum_positive" CHECK ("purchase_order_lines"."minimum_quantity" > 0);--> statement-breakpoint
-- Lines made before this carry their product's current minimum.
UPDATE "purchase_order_lines" l SET "minimum_quantity" = ps."minimum_quantity" FROM "product_suppliers" ps WHERE ps."product_id" = l."product_id";
