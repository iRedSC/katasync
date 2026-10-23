-- A write that changes the cost dates it now, unless it sets a different
-- date itself: undoing a cost puts it back as of the day it was first set.
-- A date ahead of now is taken as now.
CREATE OR REPLACE FUNCTION date_product_cost() RETURNS trigger AS $$
BEGIN
  IF NEW.unit_cost IS NULL THEN
    NEW.unit_cost_updated_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.unit_cost_updated_at := least(coalesce(NEW.unit_cost_updated_at, now()), now());
  ELSIF NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
    IF NEW.unit_cost_updated_at IS NOT DISTINCT FROM OLD.unit_cost_updated_at THEN
      NEW.unit_cost_updated_at := now();
    ELSE
      NEW.unit_cost_updated_at := least(NEW.unit_cost_updated_at, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
