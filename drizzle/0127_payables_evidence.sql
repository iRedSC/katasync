CREATE FUNCTION payables_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% rows are evidence: they are never changed or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "supplier_invoice_documents_append_only" BEFORE UPDATE OR DELETE ON "supplier_invoice_documents"
	FOR EACH ROW EXECUTE FUNCTION payables_append_only();--> statement-breakpoint
CREATE TRIGGER "supplier_invoice_lines_append_only" BEFORE UPDATE OR DELETE ON "supplier_invoice_lines"
	FOR EACH ROW EXECUTE FUNCTION payables_append_only();--> statement-breakpoint
CREATE TRIGGER "supplier_invoices_never_deleted" BEFORE UPDATE OR DELETE ON "supplier_invoices"
	FOR EACH ROW EXECUTE FUNCTION payables_append_only();--> statement-breakpoint

CREATE FUNCTION payables_close_once() RETURNS trigger AS $$
DECLARE
	before jsonb := to_jsonb(OLD) - TG_ARGV;
	after jsonb := to_jsonb(NEW) - TG_ARGV;
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION '% rows are evidence: they are never deleted', TG_TABLE_NAME;
	END IF;
	IF before <> after OR to_jsonb(OLD) ->> TG_ARGV[0] IS NOT NULL OR to_jsonb(NEW) ->> TG_ARGV[0] IS NULL THEN
		RAISE EXCEPTION '% rows only change by being closed once', TG_TABLE_NAME;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "supplier_invoice_voids_close_once" BEFORE UPDATE OR DELETE ON "supplier_invoice_voids"
	FOR EACH ROW EXECUTE FUNCTION payables_close_once('restored_at', 'restored_by');--> statement-breakpoint
CREATE TRIGGER "supplier_invoice_openings_close_once" BEFORE UPDATE OR DELETE ON "supplier_invoice_openings"
	FOR EACH ROW EXECUTE FUNCTION payables_close_once('withdrawn_at', 'withdrawn_by');--> statement-breakpoint
CREATE TRIGGER "supplier_payments_close_once" BEFORE UPDATE OR DELETE ON "supplier_payments"
	FOR EACH ROW EXECUTE FUNCTION payables_close_once('reversed_at', 'reversed_by', 'reversal_reason');--> statement-breakpoint
CREATE TRIGGER "supplier_payment_applications_close_once" BEFORE UPDATE OR DELETE ON "supplier_payment_applications"
	FOR EACH ROW EXECUTE FUNCTION payables_close_once('reversed_at', 'reversed_by');--> statement-breakpoint

CREATE FUNCTION supplier_invoice_lines_same_po() RETURNS trigger AS $$
BEGIN
	IF NOT EXISTS (SELECT FROM supplier_invoice_documents d WHERE d.invoice_id = NEW.invoice_id AND d.created_tx = txid_current()::text) THEN
		RAISE EXCEPTION 'Invoice lines are sealed with their document';
	END IF;
	IF NEW.po_line_id IS NOT NULL AND NOT EXISTS (
		SELECT FROM purchase_order_lines l JOIN supplier_invoices i ON i.purchase_order_id = l.purchase_order_id
		WHERE l.id = NEW.po_line_id AND i.id = NEW.invoice_id
	) THEN
		RAISE EXCEPTION 'Invoice line % names a line of another PO', NEW.position;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "supplier_invoice_lines_same_po" BEFORE INSERT ON "supplier_invoice_lines"
	FOR EACH ROW EXECUTE FUNCTION supplier_invoice_lines_same_po();--> statement-breakpoint

CREATE FUNCTION supplier_payment_applications_conserve() RETURNS trigger AS $$
DECLARE
	paid bigint;
	applied bigint;
	billed bigint;
	opening bigint;
BEGIN
	IF NOT EXISTS (SELECT FROM supplier_invoices WHERE id = NEW.invoice_id AND supplier_id = NEW.supplier_id) THEN
		RAISE EXCEPTION 'A payment applies only to its own supplier''s invoices';
	END IF;
	SELECT amount_cents INTO paid FROM supplier_payments WHERE id = NEW.payment_id AND reversed_at IS NULL;
	SELECT coalesce(sum(amount_cents), 0) INTO applied FROM supplier_payment_applications
		WHERE payment_id = NEW.payment_id AND reversed_at IS NULL;
	IF NEW.reversed_at IS NULL AND (paid IS NULL OR applied > paid) THEN
		RAISE EXCEPTION 'Payment % applies more than it paid', NEW.payment_id;
	END IF;
	SELECT round(total * 100)::bigint INTO billed FROM supplier_invoices WHERE id = NEW.invoice_id;
	SELECT coalesce(sum(paid_cents), 0) INTO opening FROM supplier_invoice_openings
		WHERE invoice_id = NEW.invoice_id AND withdrawn_at IS NULL;
	SELECT coalesce(sum(amount_cents), 0) INTO applied FROM supplier_payment_applications
		WHERE invoice_id = NEW.invoice_id AND reversed_at IS NULL;
	IF applied + opening > billed THEN
		RAISE EXCEPTION 'Invoice % would be paid past its total', NEW.invoice_id;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "supplier_payment_applications_conserve" AFTER INSERT ON "supplier_payment_applications"
	DEFERRABLE INITIALLY IMMEDIATE
	FOR EACH ROW EXECUTE FUNCTION supplier_payment_applications_conserve();--> statement-breakpoint

GRANT SELECT ON "supplier_invoice_documents", "supplier_invoice_lines", "supplier_invoice_voids",
	"supplier_invoice_openings", "supplier_payments", "supplier_payment_applications" TO katasync_mcp;
--> statement-breakpoint
CREATE FUNCTION payables_write_fence() RETURNS trigger AS $$
DECLARE
	owner_id integer;
BEGIN
	IF TG_TABLE_NAME IN ('supplier_payments', 'supplier_payment_applications') THEN
		owner_id := NEW.supplier_id;
	ELSE
		SELECT supplier_id INTO owner_id FROM supplier_invoices WHERE id = NEW.invoice_id;
	END IF;
	UPDATE suppliers SET name = name WHERE id = owner_id;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION payables_conserve() RETURNS trigger AS $$
DECLARE
	owner_id integer;
BEGIN
	IF TG_TABLE_NAME IN ('supplier_payments', 'supplier_payment_applications') THEN
		owner_id := NEW.supplier_id;
	ELSE
		SELECT supplier_id INTO owner_id FROM supplier_invoices WHERE id = NEW.invoice_id;
	END IF;
	IF EXISTS (
		SELECT FROM supplier_payments p WHERE p.supplier_id = owner_id
		AND (SELECT coalesce(sum(a.amount_cents), 0) FROM supplier_payment_applications a
			WHERE a.payment_id = p.id AND a.reversed_at IS NULL)
		> CASE WHEN p.reversed_at IS NULL THEN p.amount_cents ELSE 0 END
	) THEN RAISE EXCEPTION 'Payment applications exceed available payment'; END IF;
	IF EXISTS (
		SELECT FROM supplier_invoices i WHERE i.supplier_id = owner_id AND (
			(SELECT coalesce(sum(a.amount_cents), 0) FROM supplier_payment_applications a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL)
			+ (SELECT coalesce(sum(o.paid_cents), 0) FROM supplier_invoice_openings o WHERE o.invoice_id = i.id AND o.withdrawn_at IS NULL)
		) > round(i.total * 100)::bigint
	) THEN RAISE EXCEPTION 'Invoice payment evidence exceeds its total'; END IF;
	IF EXISTS (
		SELECT FROM supplier_payment_applications a JOIN supplier_invoices i ON i.id = a.invoice_id
		WHERE a.supplier_id = owner_id AND a.reversed_at IS NULL AND (
			i.supplier_id <> a.supplier_id OR EXISTS (SELECT FROM supplier_invoice_voids v WHERE v.invoice_id = i.id AND v.restored_at IS NULL)
		)
	) THEN RAISE EXCEPTION 'Payment applications require a live invoice of the same supplier'; END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
DECLARE
	relation text;
BEGIN
	FOREACH relation IN ARRAY ARRAY['supplier_invoice_documents', 'supplier_invoice_lines', 'supplier_invoice_voids', 'supplier_invoice_openings', 'supplier_payments', 'supplier_payment_applications', 'supplier_invoices'] LOOP
		EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION payables_append_only()', relation || '_no_truncate', relation);
	END LOOP;
	FOREACH relation IN ARRAY ARRAY['supplier_invoice_voids', 'supplier_invoice_openings', 'supplier_payments', 'supplier_payment_applications'] LOOP
		EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION payables_write_fence()', relation || '_write_fence', relation);
		EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payables_conserve()', relation || '_conservation', relation);
	END LOOP;
	FOREACH relation IN ARRAY ARRAY['supplier_invoice_documents', 'supplier_invoice_lines', 'supplier_invoice_voids', 'supplier_invoice_openings', 'supplier_payments', 'supplier_payment_applications'] LOOP
		EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row(%L)', relation || '_audit', relation, CASE WHEN relation = 'supplier_invoice_documents' THEN 'invoice_id' ELSE 'id' END);
	END LOOP;
END;
$$;
