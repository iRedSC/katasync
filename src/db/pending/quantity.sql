-- Custom SQL for src/db/quantity-schema.ts. Append after the generated
-- CREATE TABLE statements in the same migration, after the migration that
-- adds the 'transit' location kind. Purely additive: old deployments keep
-- serving in legacy mode, and nothing here switches modes. Activation is a
-- separate manual step (src/db/pending/quantity-activation.md).
INSERT INTO "quantity_mode" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION reject_quantity_history_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; record a compensating entry instead', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitments_append_only" BEFORE UPDATE OR DELETE ON "stock_commitments"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_parts_append_only" BEFORE UPDATE OR DELETE ON "stock_commitment_parts"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_entries_append_only" BEFORE UPDATE OR DELETE ON "stock_commitment_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "transfer_dispatches_append_only" BEFORE UPDATE OR DELETE ON "transfer_dispatches"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "transfer_dispatch_lines_append_only" BEFORE UPDATE OR DELETE ON "transfer_dispatch_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "transfer_receipts_append_only" BEFORE UPDATE OR DELETE ON "transfer_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "transfer_receipt_lines_append_only" BEFORE UPDATE OR DELETE ON "transfer_receipt_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE FUNCTION commitment_settled(commitment integer) RETURNS integer AS $$
  SELECT coalesce(sum(CASE "kind" WHEN 'restore' THEN -"quantity" ELSE "quantity" END), 0)::int
  FROM "stock_commitment_entries" WHERE "commitment_id" = commitment;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE FUNCTION guard_commitment_revision() RETURNS trigger AS $$
DECLARE
  latest "stock_commitments"%ROWTYPE;
BEGIN
  SELECT * INTO latest FROM "stock_commitments"
  WHERE "order_line_id" = NEW."order_line_id"
  ORDER BY "revision" DESC LIMIT 1 FOR UPDATE;
  IF NEW."revision" <> coalesce(latest."revision", 0) + 1 THEN
    RAISE EXCEPTION 'commitment revision % for order line % is out of sequence', NEW."revision", NEW."order_line_id";
  END IF;
  IF latest."id" IS NOT NULL AND commitment_settled(latest."id") < latest."quantity" THEN
    RAISE EXCEPTION 'order line % still has an open commitment', NEW."order_line_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitments_revision" BEFORE INSERT ON "stock_commitments"
  FOR EACH ROW EXECUTE FUNCTION guard_commitment_revision();
--> statement-breakpoint
CREATE FUNCTION add_committed_part() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "stock_commitment_entries" WHERE "commitment_id" = NEW."commitment_id") THEN
    RAISE EXCEPTION 'commitment % already has entries; its parts are fixed', NEW."commitment_id";
  END IF;
  INSERT INTO "committed_stock" ("product_id", "units")
  SELECT NEW."product_id", NEW."per_unit" * c."quantity" FROM "stock_commitments" c WHERE c."id" = NEW."commitment_id"
  ON CONFLICT ("product_id") DO UPDATE SET "units" = "committed_stock"."units" + excluded."units";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_parts_total" AFTER INSERT ON "stock_commitment_parts"
  FOR EACH ROW EXECUTE FUNCTION add_committed_part();
--> statement-breakpoint
CREATE FUNCTION guard_commitment_entry() RETURNS trigger AS $$
DECLARE
  c "stock_commitments"%ROWTYPE;
  restored "stock_commitment_entries"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "stock_commitments" WHERE "id" = NEW."commitment_id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "stock_commitments" WHERE "order_line_id" = c."order_line_id" AND "revision" > c."revision") THEN
    RAISE EXCEPTION 'commitment % was replaced by a later revision', c."id";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "stock_commitment_parts" WHERE "commitment_id" = c."id") THEN
    RAISE EXCEPTION 'commitment % has no parts', c."id";
  END IF;
  IF NEW."kind" = 'restore' THEN
    SELECT * INTO restored FROM "stock_commitment_entries" WHERE "id" = NEW."restores_entry_id";
    IF restored."id" IS NULL OR restored."kind" <> 'consume' OR restored."commitment_id" <> c."id"
      OR restored."quantity" <> NEW."quantity" OR restored."batch_id" <> NEW."batch_id" THEN
      RAISE EXCEPTION 'restore must match a consume entry of commitment %', c."id";
    END IF;
  ELSIF commitment_settled(c."id") + NEW."quantity" > c."quantity" THEN
    RAISE EXCEPTION 'commitment % has only % left', c."id", c."quantity" - commitment_settled(c."id");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_entries_guard" BEFORE INSERT ON "stock_commitment_entries"
  FOR EACH ROW EXECUTE FUNCTION guard_commitment_entry();
--> statement-breakpoint
CREATE FUNCTION settle_committed_parts() RETURNS trigger AS $$
BEGIN
  UPDATE "committed_stock" s
  SET "units" = s."units" + p."per_unit" * NEW."quantity" * (CASE NEW."kind" WHEN 'restore' THEN 1 ELSE -1 END)
  FROM "stock_commitment_parts" p
  WHERE p."commitment_id" = NEW."commitment_id" AND s."product_id" = p."product_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_entries_total" AFTER INSERT ON "stock_commitment_entries"
  FOR EACH ROW EXECUTE FUNCTION settle_committed_parts();
--> statement-breakpoint
CREATE FUNCTION guard_transfer_dispatch() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "locations" WHERE "id" = NEW."transit_location_id" AND "kind" = 'transit') THEN
    RAISE EXCEPTION 'location % is not a transit location', NEW."transit_location_id";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "transfers" WHERE "id" = NEW."transfer_id" AND "batch_id" = NEW."batch_id") THEN
    RAISE EXCEPTION 'dispatch batch must be transfer %''s sent batch', NEW."transfer_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "transfer_dispatches_guard" BEFORE INSERT ON "transfer_dispatches"
  FOR EACH ROW EXECUTE FUNCTION guard_transfer_dispatch();
--> statement-breakpoint
CREATE FUNCTION guard_transfer_receipt_line() RETURNS trigger AS $$
DECLARE
  dispatch integer;
  sent integer;
  received integer;
BEGIN
  SELECT r."dispatch_id" INTO dispatch FROM "transfer_receipts" r WHERE r."id" = NEW."receipt_id";
  PERFORM 1 FROM "transfer_dispatches" WHERE "id" = dispatch FOR UPDATE;
  SELECT "quantity" INTO sent FROM "transfer_dispatch_lines"
  WHERE "dispatch_id" = dispatch AND "product_id" = NEW."product_id";
  IF sent IS NULL THEN
    RAISE EXCEPTION 'product % was not sent on dispatch %', NEW."product_id", dispatch;
  END IF;
  SELECT coalesce(sum(l."quantity"), 0)::int INTO received
  FROM "transfer_receipt_lines" l
  JOIN "transfer_receipts" r ON r."id" = l."receipt_id"
  WHERE r."dispatch_id" = dispatch AND l."product_id" = NEW."product_id"
    AND NOT EXISTS (SELECT 1 FROM "movements" m WHERE m."reference" = 'undo:' || r."batch_id"::text);
  IF received + NEW."quantity" > sent THEN
    RAISE EXCEPTION 'only % of product % is still in transit', sent - received, NEW."product_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "transfer_receipt_lines_guard" BEFORE INSERT ON "transfer_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION guard_transfer_receipt_line();
--> statement-breakpoint
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
GRANT SELECT ON "quantity_mode", "stock_commitments", "stock_commitment_parts", "stock_commitment_entries", "committed_stock", "transfer_dispatches", "transfer_dispatch_lines", "transfer_receipts", "transfer_receipt_lines" TO katasync_mcp;
