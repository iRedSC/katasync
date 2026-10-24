CREATE OR REPLACE VIEW "owned_stock" AS
SELECT p."id" AS "product_id", p."sku", coalesce(sum(s."on_hand"), 0)::int AS "on_hand"
FROM "products" p
LEFT JOIN "stock_levels" s ON s."product_id" = p."id"
	AND s."location_id" IN (SELECT "id" FROM "locations" WHERE "kind" IN ('owned', 'retail'))
WHERE p."kind" <> 'bundle'
GROUP BY p."id", p."sku";
--> statement-breakpoint
CREATE FUNCTION commitment_released(commitment integer) RETURNS integer AS $$
  SELECT coalesce(sum("quantity"), 0)::int
  FROM "stock_commitment_entries" WHERE "commitment_id" = commitment AND "kind" = 'release';
$$ LANGUAGE sql STABLE;
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
HAVING sum(p."per_unit" * (k."quantity" - commitment_released(k."id"))) > 0;
--> statement-breakpoint
GRANT SELECT ON "quantity_mode", "unreserved_shipments", "stock_commitments", "stock_commitment_parts", "stock_commitment_entries", "committed_stock", "transfer_dispatches", "transfer_dispatch_lines", "transfer_receipts", "transfer_receipt_lines" TO katasync_mcp;
--> statement-breakpoint
CREATE TRIGGER quantity_mode_audit AFTER UPDATE ON quantity_mode
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER stock_commitments_audit AFTER INSERT ON stock_commitments
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER stock_commitment_entries_audit AFTER INSERT ON stock_commitment_entries
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER unreserved_shipments_audit AFTER INSERT ON unreserved_shipments
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER transfer_dispatches_audit AFTER INSERT ON transfer_dispatches
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER transfer_receipts_audit AFTER INSERT ON transfer_receipts
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
