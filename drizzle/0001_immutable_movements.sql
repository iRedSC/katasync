-- Movements are the ledger's source of truth. Corrections are new movements,
-- never edits, so the history always explains the current stock.
CREATE FUNCTION reject_movement_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'movements are append-only; post a compensating movement instead';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER movements_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON movements
  FOR EACH STATEMENT EXECUTE FUNCTION reject_movement_change();
