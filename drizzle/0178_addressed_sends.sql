-- A package sent to an address for no order (contents 'addressed', see
-- dispatches in schema.ts). It never has orders, so nothing order-side
-- (handoff, profit, stock) can count it.
ALTER TABLE "dispatches" DROP CONSTRAINT "dispatches_contents_known";--> statement-breakpoint
ALTER TABLE "dispatches" DROP CONSTRAINT "dispatches_packed_box_count";--> statement-breakpoint
ALTER TABLE "dispatches" ADD COLUMN "sent_to" jsonb;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_addressed_sent_to" CHECK (("dispatches"."contents" = 'addressed') = ("dispatches"."sent_to" is not null));--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_addressed_one_box" CHECK ("dispatches"."contents" <> 'addressed' or "dispatches"."box_count" = 1);--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_contents_known" CHECK ("dispatches"."contents" in ('packed', 'unknown', 'addressed'));--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_packed_box_count" CHECK (("dispatches"."contents" in ('packed', 'addressed')) = ("dispatches"."box_count" is not null and "dispatches"."box_count" > 0));--> statement-breakpoint
CREATE FUNCTION dispatch_orders_not_addressed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM dispatches WHERE id = NEW.dispatch_id AND contents = 'addressed') THEN
    RAISE EXCEPTION 'dispatch % was sent to an address, not for orders', NEW.dispatch_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER dispatch_orders_not_addressed BEFORE INSERT OR UPDATE OF dispatch_id ON dispatch_orders
  FOR EACH ROW EXECUTE FUNCTION dispatch_orders_not_addressed();
