-- What's to pick for an order, versioned, so a print acknowledged late
-- can't mark newer picking work printed (src/server/orders/invoices.ts).
-- The version goes up here, not in each caller, so no path that changes an
-- order's packing contents or puts it back in Print all can forget it:
--
-- 1. An order joins a dispatch (a box bought), its part is handed off, or
--    its part is taken back (voided): dispatch_orders inserted, or its
--    channel_sent_at or reversed_at changed.
-- 2. Its invoice counts as unprinted again: invoice_printed_at cleared.

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
