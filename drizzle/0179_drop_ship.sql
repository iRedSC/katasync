-- Drop-ships: a supplier ships the order straight to the buyer (see
-- src/shipping/drop-ship.ts). Such an order never gets a pin or a label, so
-- dispatch_orders refuses it outright: no packing path can ship it from our
-- shelf by mistake.
ALTER TABLE "orders" ADD COLUMN "drop_ship_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "drop_ship_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "drop_ship_carrier" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "drop_ship_tracking" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_drop_ship_sent" CHECK ("orders"."drop_ship_sent_at" is null or "orders"."drop_ship_at" is not null);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_drop_ship_tracking" CHECK (("orders"."drop_ship_tracking" is null or "orders"."drop_ship_sent_at" is not null) and ("orders"."drop_ship_tracking" is null) = ("orders"."drop_ship_carrier" is null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_drop_ship_no_pin" CHECK ("orders"."drop_ship_at" is null or "orders"."pin" is null);--> statement-breakpoint
CREATE FUNCTION dispatch_orders_not_drop_ship() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND drop_ship_at IS NOT NULL) THEN
    RAISE EXCEPTION 'order % is drop-shipped by a supplier, so it gets no label', NEW.order_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER dispatch_orders_not_drop_ship BEFORE INSERT OR UPDATE OF order_id ON dispatch_orders
  FOR EACH ROW EXECUTE FUNCTION dispatch_orders_not_drop_ship();
