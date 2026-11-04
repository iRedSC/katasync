-- An order can go out in several shipments over time, staff choosing which
-- units ship now (src/orders/remaining.ts). Two rules keep that from
-- packing a unit twice, here so no code path can get around them:
--
-- 1. An order has at most one live dispatch not yet handed off to its
--    marketplace. Handed-off ones can be any number.
-- 2. A dispatch line never takes more of an order line than is packable:
--    its quantity, less what the marketplace says shipped (unknown means
--    nothing is packable), less what live dispatches not yet handed off
--    already hold. Units katasync handed off count only through the
--    marketplace's own count, which must already cover them; a count
--    lower than that is a snapshot from before the handoff, so nothing is
--    packable until the next sync brings it up to date.
--
-- Each check locks the row it counts against (the order, the order line),
-- so two purchases at once take turns and the second sees the first. A
-- dispatch only counts as live once it has a label or a label purchase
-- (dispatch_is_live), so buyDispatch saves the first purchase in the same
-- transaction as the dispatch.

CREATE FUNCTION dispatch_is_live(p_dispatch integer) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM shipments s WHERE s.dispatch_id = p_dispatch AND s.voided_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM label_attempts a WHERE a.dispatch_id = p_dispatch AND a.state IN ('pending', 'unknown')
  )
$$;
--> statement-breakpoint
-- Units of an order line in this order's dispatches handed off to its
-- marketplace and not taken back by a void.
CREATE FUNCTION order_line_handed_off(p_order integer, p_line text) RETURNS integer
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.quantity), 0)::integer
  FROM dispatch_lines l
  JOIN dispatch_orders o ON o.dispatch_id = l.dispatch_id AND o.order_id = l.order_id
  WHERE l.order_id = p_order AND l.line_external_id = p_line
    AND o.channel_sent_at IS NOT NULL AND o.reversed_at IS NULL
$$;
--> statement-breakpoint
-- Units of an order line in this order's live dispatches not yet handed
-- off: bought, or a purchase not yet settled.
CREATE FUNCTION order_line_unsent(p_order integer, p_line text) RETURNS integer
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.quantity), 0)::integer
  FROM dispatch_lines l
  JOIN dispatch_orders o ON o.dispatch_id = l.dispatch_id AND o.order_id = l.order_id
  WHERE l.order_id = p_order AND l.line_external_id = p_line
    AND o.channel_sent_at IS NULL AND o.reversed_at IS NULL
    AND dispatch_is_live(l.dispatch_id)
$$;
--> statement-breakpoint
CREATE FUNCTION dispatch_orders_one_unsent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM dispatch_orders o
    WHERE o.order_id = NEW.order_id AND o.dispatch_id <> NEW.dispatch_id
      AND o.channel_sent_at IS NULL AND o.reversed_at IS NULL
      AND dispatch_is_live(o.dispatch_id)
  ) THEN
    RAISE EXCEPTION 'order % already has a label not yet handed off', NEW.order_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dispatch_orders_one_unsent BEFORE INSERT ON dispatch_orders
  FOR EACH ROW EXECUTE FUNCTION dispatch_orders_one_unsent();
--> statement-breakpoint
CREATE FUNCTION dispatch_lines_packable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line record;
  handed integer;
BEGIN
  SELECT quantity, shipped_quantity INTO line FROM order_lines
  WHERE order_id = NEW.order_id AND external_id = NEW.line_external_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % has no line %', NEW.order_id, NEW.line_external_id;
  END IF;
  handed := order_line_handed_off(NEW.order_id, NEW.line_external_id);
  IF line.shipped_quantity < handed THEN
    RAISE EXCEPTION 'line % of order %: the marketplace says % shipped, but % were handed off; wait for the next sync',
      NEW.line_external_id, NEW.order_id, line.shipped_quantity, handed;
  END IF;
  IF order_line_unsent(NEW.order_id, NEW.line_external_id) + NEW.quantity
    > line.quantity - coalesce(least(line.shipped_quantity, line.quantity), line.quantity) THEN
    RAISE EXCEPTION 'line % of order % has fewer than % units left to pack',
      NEW.line_external_id, NEW.order_id, NEW.quantity;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dispatch_lines_packable BEFORE INSERT ON dispatch_lines
  FOR EACH ROW EXECUTE FUNCTION dispatch_lines_packable();
