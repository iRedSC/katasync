-- What's to pick for an order, versioned, so a print acknowledged late
-- can't mark newer picking work printed (src/server/orders/invoices.ts).
-- The version goes up here, not in each caller, so no path that changes an
-- order's packing contents or puts it back in Print all can forget it:
--
-- 1. An order joins a dispatch (a box bought), its part is handed off, or
--    its part is taken back (voided): dispatch_orders inserted, or its
--    channel_sent_at or reversed_at changed.
-- 2. Its invoice counts as unprinted again: invoice_printed_at cleared.
-- 3. A sync changes what its lines say to pick: a line added, or its
--    count, shipped count, product, title or SKU changed, or the id a
--    bought box matches it by (a TikTok order moved to its own store).
-- 4. A refused purchase leaves its dispatch with no label and no purchase
--    in flight (dispatch_is_live false), so the slip goes back to the
--    whole order: every order in it.
--
-- 3 and 4 change the picking work itself, so they also put the order back
-- in Print all, through orders_picking_changed, which clears the printed
-- mark of an order still to pack (to-ship.ts's needsPacking, without its
-- refund sum: an order refunded in full loses its printed mark, harmless,
-- since Print all leaves it out anyway). Clearing it bumps the version
-- through 2, so the version goes up exactly once either way.

ALTER TABLE "orders" ADD COLUMN "picking_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE FUNCTION orders_unprinted_bumps_picking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.picking_version := OLD.picking_version + 1;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER orders_unprinted_bumps_picking BEFORE UPDATE OF invoice_printed_at ON orders
  FOR EACH ROW
  WHEN (OLD.invoice_printed_at IS NOT NULL AND NEW.invoice_printed_at IS NULL)
  EXECUTE FUNCTION orders_unprinted_bumps_picking();
--> statement-breakpoint
CREATE FUNCTION dispatch_orders_bump_picking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE orders SET picking_version = picking_version + 1 WHERE id = NEW.order_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER dispatch_orders_bought_bumps_picking AFTER INSERT ON dispatch_orders
  FOR EACH ROW EXECUTE FUNCTION dispatch_orders_bump_picking();
--> statement-breakpoint
CREATE TRIGGER dispatch_orders_moved_bumps_picking AFTER UPDATE OF channel_sent_at, reversed_at ON dispatch_orders
  FOR EACH ROW
  WHEN (
    OLD.channel_sent_at IS DISTINCT FROM NEW.channel_sent_at
    OR OLD.reversed_at IS DISTINCT FROM NEW.reversed_at
  )
  EXECUTE FUNCTION dispatch_orders_bump_picking();
--> statement-breakpoint
CREATE FUNCTION orders_picking_changed(p_orders integer[]) RETURNS void LANGUAGE sql AS $$
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
  WHERE id = ANY(p_orders)
$$;
--> statement-breakpoint
CREATE FUNCTION order_lines_bump_picking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM orders_picking_changed(ARRAY[NEW.order_id]);
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
--> statement-breakpoint
CREATE FUNCTION label_attempts_refused_bumps_picking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT dispatch_is_live(NEW.dispatch_id) THEN
    PERFORM orders_picking_changed(ARRAY(
      SELECT order_id FROM dispatch_orders WHERE dispatch_id = NEW.dispatch_id
    ));
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER label_attempts_refused_bumps_picking AFTER UPDATE OF state ON label_attempts
  FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state = 'failed')
  EXECUTE FUNCTION label_attempts_refused_bumps_picking();
