-- A product that became a tool set after it sold (src/products/kind.ts)
-- has recorded sales naming itself. It has no stock now, and a unit of it
-- means its parts, so those count as its parts, by the recipe as it stands.
-- A tool set's own sales already name its parts, and parts are never tool
-- sets, so expanding every row changes nothing else.
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
LEFT JOIN "product_components" c ON c."parent_product_id" = s."product_id" AND p."kind" = 'bundle';
