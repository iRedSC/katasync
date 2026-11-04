-- A plain order's lines, versioned, so a print acknowledged late can't mark
-- newer picking work printed (src/orders/printed.ts). Only a plain order's
-- print counts (src/orders/to-ship.ts's plain: no katasync dispatch, nothing
-- shipped), and its slip is just its lines, so a change to them is all that
-- can make a print stale: a line added, or its count, shipped count,
-- product, title, SKU or external id changed. The version goes up here, not
-- in each caller, so no sync path can forget it. The same change clears the
-- printed mark of an order still to pack (to-ship.ts's needsPacking, without
-- its refund sum: an order refunded in full loses its printed mark, harmless,
-- since Print all leaves it out anyway), so Print all prints it again.

ALTER TABLE "orders" ADD COLUMN "picking_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE FUNCTION order_lines_bump_picking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE orders SET
    picking_version = picking_version + 1,
    invoice_printed_at = CASE
      WHEN cancelled_at IS NULL
        AND drop_ship_at IS NULL
        AND fulfillment_status NOT IN ('FULFILLED', 'FULFILLMENT_NOT_REQUIRED', 'RESTOCKED', 'AWAITING_PAYMENT')
        AND coalesce(financial_status, '') NOT IN ('REFUNDED', 'VOIDED')
      THEN NULL
      ELSE invoice_printed_at
    END
  WHERE id = NEW.order_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER order_lines_added_bumps_picking AFTER INSERT ON order_lines
  FOR EACH ROW EXECUTE FUNCTION order_lines_bump_picking();
--> statement-breakpoint
CREATE TRIGGER order_lines_changed_bumps_picking
  AFTER UPDATE OF quantity, shipped_quantity, product_id, title, sku, external_id ON order_lines
  FOR EACH ROW
  WHEN (
    OLD.quantity IS DISTINCT FROM NEW.quantity
    OR OLD.shipped_quantity IS DISTINCT FROM NEW.shipped_quantity
    OR OLD.product_id IS DISTINCT FROM NEW.product_id
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.sku IS DISTINCT FROM NEW.sku
    OR OLD.external_id IS DISTINCT FROM NEW.external_id
  )
  EXECUTE FUNCTION order_lines_bump_picking();
