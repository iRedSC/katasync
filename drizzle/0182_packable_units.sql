-- An order can go out in several shipments over time, staff choosing which
-- units ship now (src/orders/remaining.ts). These rules keep that from
-- packing a unit twice, here so no code path can get around them:
--
-- 1. An order has at most one live dispatch not yet handed off to its
--    marketplace. Handed-off ones can be any number.
-- 2. A dispatch line never takes more of an order line than is packable:
--    its quantity, less what the marketplace says shipped (unknown means
--    nothing is packable), less what live dispatches not yet handed off
--    already hold. Units katasync handed off count only through the
--    marketplace's own count, which must already cover them (the fence,
--    order_line_shipped_needed); a count lower than that is a snapshot from
--    before the handoff, so nothing is packable until the next sync brings
--    it up to date.
-- 3. Every order in a packed dispatch has at least one of its lines in it,
--    so no handoff tells a marketplace about an empty box.
--
-- Each dispatch line keeps the line's shipped count as it was bought
-- (shipped_before), set here, not by the app. Buying needs that count fresh
-- (rule 2), and only one dispatch is unsent at a time (rule 1), so it
-- already counts every earlier handoff, and units shipped outside katasync
-- too. The fence is then that count plus the newest handoff's units, less
-- any of those earlier handoffs voided since (order_line_shipped_needed).
--
-- Each check locks the row it counts against (the order, the order line),
-- so two purchases at once take turns and the second sees the first. A
-- dispatch only counts as live once it has a label or a label purchase
-- (dispatch_is_live), so buyDispatch saves the first purchase in the same
-- transaction as the dispatch.

ALTER TABLE "dispatch_lines" ADD COLUMN "shipped_before" integer;
--> statement-breakpoint
ALTER TABLE "dispatch_lines" ADD COLUMN "handed_off_before" integer;
--> statement-breakpoint
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
-- marketplace and not taken back by a void, counting only dispatches older
-- than p_before when given.
CREATE FUNCTION order_line_handed_off(p_order integer, p_line text, p_before integer DEFAULT NULL) RETURNS integer
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(l.quantity), 0)::integer
  FROM dispatch_lines l
  JOIN dispatch_orders o ON o.dispatch_id = l.dispatch_id AND o.order_id = l.order_id
  WHERE l.order_id = p_order AND l.line_external_id = p_line
    AND o.channel_sent_at IS NOT NULL AND o.reversed_at IS NULL
    AND (p_before IS NULL OR l.dispatch_id < p_before)
$$;
--> statement-breakpoint
-- What the marketplace's shipped count must reach to cover katasync's own
-- handoffs of an order line: the count when its newest handed-off, unreversed
-- dispatch (D2) was bought, plus D2's units, less units of earlier handoffs
-- that count included and a void has since taken back. Never below 0.
--
-- Which earlier handoffs the count included is decided from our own rows:
-- handed_off_before is the units handed off and unreversed when D2 was
-- bought, which the fence then made shipped_before cover. Every one of them
-- is an older dispatch: the trigger refuses a line while a newer dispatch of
-- the order is handed off, so ids order purchases. And no older dispatch is
-- handed off after D2 was bought: it would have been live and unsent then,
-- which rule 1 refuses, and a dead dispatch never comes back to life (a
-- voided label stays voided, a failed purchase stays failed). Handoffs and
-- voids only go one way, so what's left of that set is the older dispatches
-- still handed off and unreversed, and the difference is what was voided
-- since. A void from before D2 was bought is not subtracted: the count may
-- or may not have dropped for it, and shipped_before already says which.
--
-- Lowering the fence this way is safe. A snapshot from before D2 was
-- handed off reads at most shipped_before: it lacks D2's units and may
-- still count the voided ones. When D2 holds more than was voided, it falls
-- short of the lowered fence and is refused. Otherwise it passes, but packs
-- no more than is truly left, since it counts at least as many units as
-- the marketplace now has shipped. A marketplace that keeps voided tracking
-- (eBay) keeps reporting the higher count: that clears the fence and only
-- makes those units unpackable, never shipped twice.
--
-- One bought before shipped_before was kept (null, so is
-- handed_off_before) has nothing older under it (an order had one dispatch
-- then), so all units handed off stand in.
CREATE FUNCTION order_line_shipped_needed(p_order integer, p_line text) RETURNS integer
  LANGUAGE sql STABLE AS $$
  -- Clamped outside the coalesce: greatest() skips a null, which would hide
  -- the fallback.
  SELECT greatest(0, coalesce(
    (SELECT l.shipped_before + l.quantity
       - (l.handed_off_before - order_line_handed_off(p_order, p_line, l.dispatch_id))
     FROM dispatch_lines l
     JOIN dispatch_orders o ON o.dispatch_id = l.dispatch_id AND o.order_id = l.order_id
     WHERE l.order_id = p_order AND l.line_external_id = p_line
       AND o.channel_sent_at IS NOT NULL AND o.reversed_at IS NULL
     ORDER BY l.dispatch_id DESC LIMIT 1),
    order_line_handed_off(p_order, p_line)
  ))
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
  needed integer;
BEGIN
  SELECT quantity, shipped_quantity INTO line FROM order_lines
  WHERE order_id = NEW.order_id AND external_id = NEW.line_external_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % has no line %', NEW.order_id, NEW.line_external_id;
  END IF;
  -- Purchases of an order are ordered by dispatch id (see
  -- order_line_shipped_needed), so none joins behind a newer handoff.
  IF EXISTS (
    SELECT 1 FROM dispatch_orders o
    WHERE o.order_id = NEW.order_id AND o.dispatch_id > NEW.dispatch_id
      AND o.channel_sent_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'order % has a newer shipment already handed off; buy again', NEW.order_id;
  END IF;
  needed := order_line_shipped_needed(NEW.order_id, NEW.line_external_id);
  IF line.shipped_quantity < needed THEN
    RAISE EXCEPTION 'line % of order %: the marketplace says % shipped, but katasync''s handoffs make %; wait for the next sync',
      NEW.line_external_id, NEW.order_id, line.shipped_quantity, needed;
  END IF;
  IF order_line_unsent(NEW.order_id, NEW.line_external_id) + NEW.quantity
    > line.quantity - coalesce(least(line.shipped_quantity, line.quantity), line.quantity) THEN
    RAISE EXCEPTION 'line % of order % has fewer than % units left to pack',
      NEW.line_external_id, NEW.order_id, NEW.quantity;
  END IF;
  NEW.shipped_before := line.shipped_quantity;
  NEW.handed_off_before := order_line_handed_off(NEW.order_id, NEW.line_external_id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dispatch_lines_packable BEFORE INSERT ON dispatch_lines
  FOR EACH ROW EXECUTE FUNCTION dispatch_lines_packable();
--> statement-breakpoint
CREATE FUNCTION dispatch_orders_packed_has_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM dispatches d WHERE d.id = NEW.dispatch_id AND d.contents = 'packed'
  ) AND NOT EXISTS (
    SELECT 1 FROM dispatch_lines l
    WHERE l.dispatch_id = NEW.dispatch_id AND l.order_id = NEW.order_id
  ) THEN
    RAISE EXCEPTION 'order % is in packed dispatch % with none of its lines', NEW.order_id, NEW.dispatch_id;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER dispatch_orders_packed_has_lines
  AFTER INSERT ON dispatch_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION dispatch_orders_packed_has_lines();
