-- A plain order's lines, versioned, so a print acknowledged late can't mark
-- newer picking work printed (src/orders/printed.ts). Only a plain order's
-- print counts (src/orders/to-ship.ts's plain: no katasync dispatch, nothing
-- shipped), and its slip is just its lines, so a change to them is all that
-- can make a print stale: a line added, or its count, shipped count,
-- product, title, SKU, external id or price changed, or what the invoice
-- prints from the order itself (src/server/orders/invoices.ts: its name,
-- pin, buyer, ship-to address, total, shipping or payment status). Catalog
-- edits (a product's name or parts) don't count. The version goes up here, not
-- in each caller, so no sync path can forget it. The same change clears the
-- printed mark of an order still to pack (to-ship.ts's needsPacking, without
-- its refund sum: an order refunded in full loses its printed mark, harmless,
-- since Print all leaves it out anyway), so Print all prints it again.

ALTER TABLE "orders" ADD COLUMN "picking_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE FUNCTION bump_order_picking(target integer) RETURNS void LANGUAGE plpgsql AS $$
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
  WHERE id = target;
END $$;
--> statement-breakpoint
CREATE FUNCTION order_lines_bump_picking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_order_picking(NEW.order_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION orders_bump_picking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_order_picking(NEW.id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER order_lines_added_bumps_picking AFTER INSERT ON order_lines
  FOR EACH ROW EXECUTE FUNCTION order_lines_bump_picking();
--> statement-breakpoint
CREATE TRIGGER order_lines_changed_bumps_picking
  AFTER UPDATE OF quantity, shipped_quantity, product_id, title, sku, external_id, unit_price ON order_lines
  FOR EACH ROW
  WHEN (
    OLD.quantity IS DISTINCT FROM NEW.quantity
    OR OLD.shipped_quantity IS DISTINCT FROM NEW.shipped_quantity
    OR OLD.product_id IS DISTINCT FROM NEW.product_id
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.sku IS DISTINCT FROM NEW.sku
    OR OLD.external_id IS DISTINCT FROM NEW.external_id
    OR OLD.unit_price IS DISTINCT FROM NEW.unit_price
  )
  EXECUTE FUNCTION order_lines_bump_picking();
--> statement-breakpoint
-- Only the printed columns: the bump's own update of picking_version and
-- invoice_printed_at never fires it again.
CREATE TRIGGER orders_printed_changed_bumps_picking
  AFTER UPDATE OF name, pin, sales_channel, placed_at, customer_name, ship_address1, ship_address2, ship_city, ship_region, ship_postal_code, ship_country, total, shipping_charged, financial_status ON orders
  FOR EACH ROW
  WHEN (
    OLD.name IS DISTINCT FROM NEW.name
    OR OLD.pin IS DISTINCT FROM NEW.pin
    OR OLD.sales_channel IS DISTINCT FROM NEW.sales_channel
    OR OLD.placed_at IS DISTINCT FROM NEW.placed_at
    OR OLD.customer_name IS DISTINCT FROM NEW.customer_name
    OR OLD.ship_address1 IS DISTINCT FROM NEW.ship_address1
    OR OLD.ship_address2 IS DISTINCT FROM NEW.ship_address2
    OR OLD.ship_city IS DISTINCT FROM NEW.ship_city
    OR OLD.ship_region IS DISTINCT FROM NEW.ship_region
    OR OLD.ship_postal_code IS DISTINCT FROM NEW.ship_postal_code
    OR OLD.ship_country IS DISTINCT FROM NEW.ship_country
    OR OLD.total IS DISTINCT FROM NEW.total
    OR OLD.shipping_charged IS DISTINCT FROM NEW.shipping_charged
    OR OLD.financial_status IS DISTINCT FROM NEW.financial_status
  )
  EXECUTE FUNCTION orders_bump_picking();
