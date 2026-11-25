ALTER TABLE "products" ADD COLUMN "whole_set_of_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_whole_set_of_id_products_id_fk" FOREIGN KEY ("whole_set_of_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_whole_set_of_idx" ON "products" USING btree ("whole_set_of_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_whole_set_is_kit" CHECK ("products"."whole_set_of_id" is null or "products"."kind" = 'kit');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_whole_set_is_counted" CHECK ("products"."whole_set_of_id" is null or "products"."not_counted_since" is null);--> statement-breakpoint
-- An order line for a tool set can be held partly as whole sets and partly
-- as loose parts (src/inventory/whole-sets.ts): two commitments, since each
-- freezes one list of parts. So a line may have more than one open, but only
-- ones made together, in this transaction, for the same product. Anything
-- older must be settled first, as before.
CREATE OR REPLACE FUNCTION guard_commitment_revision() RETURNS trigger AS $$
DECLARE
  latest "stock_commitments"%ROWTYPE;
BEGIN
  SELECT * INTO latest FROM "stock_commitments"
  WHERE "order_line_id" = NEW."order_line_id"
  ORDER BY "revision" DESC LIMIT 1 FOR UPDATE;
  IF NEW."revision" <> coalesce(latest."revision", 0) + 1 THEN
    RAISE EXCEPTION 'commitment revision % for order line % is out of sequence', NEW."revision", NEW."order_line_id";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "stock_commitments" k
    WHERE k."order_line_id" = NEW."order_line_id" AND commitment_settled(k."id") < k."quantity"
      AND (k."created_tx" <> txid_current()::text OR k."product_id" <> NEW."product_id")
  ) THEN
    RAISE EXCEPTION 'order line % still has an open commitment', NEW."order_line_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- A whole set that sold is its tool set sold: its units count as the set's
-- parts, by the set's recipe, exactly as a sale from loose parts does, so
-- demand for the parts doesn't dip while the boxes sell through.
CREATE OR REPLACE VIEW "sales_units" AS
SELECT coalesce(c."component_product_id", s."product_id") AS "product_id",
  s."order_id", s."store_id", s."placed_at",
  (s."units" * coalesce(c."quantity", 1))::int AS "units"
FROM (
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
    ))
    AND NOT EXISTS (SELECT 1 FROM "stock_commitments" k WHERE k."order_line_id" = l."id")
  UNION ALL
  SELECT p."product_id", o."id" AS "order_id", o."store_id", o."placed_at",
    sum(p."per_unit" * (k."quantity" - commitment_released(k."id")))::int AS "units"
  FROM "stock_commitments" k
  JOIN "stock_commitment_parts" p ON p."commitment_id" = k."id"
  JOIN "orders" o ON o."id" = k."order_id"
  WHERE o."cancelled_at" IS NULL AND NOT o."fulfilled_by_channel"
  GROUP BY p."product_id", o."id", o."store_id", o."placed_at"
  HAVING sum(p."per_unit" * (k."quantity" - commitment_released(k."id"))) > 0
) s
JOIN "products" p ON p."id" = s."product_id"
LEFT JOIN "product_components" c
  ON c."parent_product_id" = coalesce(p."whole_set_of_id", s."product_id")
  AND (p."kind" = 'bundle' OR p."whole_set_of_id" IS NOT NULL);
