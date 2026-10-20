ALTER TABLE "products" ADD COLUMN "unit_cost_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_cost_date_needs_cost" CHECK ("products"."unit_cost_updated_at" is null or "products"."unit_cost" is not null);--> statement-breakpoint
-- Every way a cost gets written dates it, so no code path can forget. A
-- write that keeps the same cost leaves the date alone unless it sets one
-- itself (receiving a PO, editing the cost). No cost, no date.
CREATE FUNCTION date_product_cost() RETURNS trigger AS $$
BEGIN
  IF NEW.unit_cost IS NULL THEN
    NEW.unit_cost_updated_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.unit_cost_updated_at := coalesce(NEW.unit_cost_updated_at, now());
  ELSIF NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
    NEW.unit_cost_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER products_date_cost
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION date_product_cost();
