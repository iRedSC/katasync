ALTER TABLE "stock_commitments" ADD COLUMN "created_tx" text DEFAULT txid_current()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_dispatches" ADD COLUMN "created_tx" text DEFAULT txid_current()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_receipts" ADD COLUMN "created_tx" text DEFAULT txid_current()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_lines" ADD COLUMN "order_line_id" integer;
--> statement-breakpoint
CREATE FUNCTION seal_quantity_details() RETURNS trigger AS $$
DECLARE
  creation_tx text;
BEGIN
  IF TG_TABLE_NAME = 'stock_commitment_parts' THEN
    SELECT created_tx INTO creation_tx FROM stock_commitments WHERE id = NEW.commitment_id;
  ELSIF TG_TABLE_NAME = 'transfer_dispatch_lines' THEN
    SELECT created_tx INTO creation_tx FROM transfer_dispatches WHERE id = NEW.dispatch_id;
  ELSE
    SELECT created_tx INTO creation_tx FROM transfer_receipts WHERE id = NEW.receipt_id;
  END IF;
  IF creation_tx IS DISTINCT FROM txid_current()::text THEN
    RAISE EXCEPTION '% details must be frozen in their creation transaction', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER stock_commitment_parts_seal BEFORE INSERT ON stock_commitment_parts
  FOR EACH ROW EXECUTE FUNCTION seal_quantity_details();
--> statement-breakpoint
CREATE TRIGGER transfer_dispatch_lines_seal BEFORE INSERT ON transfer_dispatch_lines
  FOR EACH ROW EXECUTE FUNCTION seal_quantity_details();
--> statement-breakpoint
CREATE TRIGGER transfer_receipt_lines_seal BEFORE INSERT ON transfer_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION seal_quantity_details();
