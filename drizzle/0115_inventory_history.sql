ALTER TYPE "public"."location_kind" ADD VALUE 'transit';--> statement-breakpoint
CREATE INDEX "movements_batch_idx" ON "movements" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "movements_reference_idx" ON "movements" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "order_lines_sale_batch_idx" ON "order_lines" USING btree ("sale_batch_id");--> statement-breakpoint
CREATE INDEX "order_lines_unsettled_idx" ON "order_lines" USING btree ("id") WHERE "order_lines"."sale_batch_id" is null and "order_lines"."product_id" is not null;
--> statement-breakpoint
CREATE OR REPLACE VIEW "sales_units" AS
SELECT m."product_id", o."id" AS "order_id", o."store_id", o."placed_at",
  (-m."delta")::int AS "units"
FROM "movements" m
JOIN "order_lines" l ON l."sale_batch_id" = m."batch_id"
JOIN "orders" o ON o."id" = l."order_id"
WHERE m."reason" = 'sale'
  AND o."cancelled_at" IS NULL AND NOT o."fulfilled_by_channel"
  AND NOT EXISTS (
    SELECT 1 FROM "movements" u WHERE u."reference" = 'undo:' || m."batch_id"::text
  )
UNION ALL
SELECT coalesce(c."component_product_id", l."product_id") AS "product_id",
  o."id" AS "order_id", o."store_id", o."placed_at",
  (l."quantity" * coalesce(c."quantity", 1))::int AS "units"
FROM "order_lines" l
JOIN "orders" o ON o."id" = l."order_id"
JOIN "products" p ON p."id" = l."product_id"
LEFT JOIN "product_components" c ON c."parent_product_id" = l."product_id" AND p."kind" = 'bundle'
WHERE o."cancelled_at" IS NULL AND NOT o."fulfilled_by_channel"
  AND (l."sale_batch_id" IS NULL OR EXISTS (
    SELECT 1 FROM "movements" u WHERE u."reference" = 'undo:' || l."sale_batch_id"::text
  ));
