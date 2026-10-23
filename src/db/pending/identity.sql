-- Hand-written part of the named-staff migration. Append after the
-- drizzle-generated DDL for src/db/identity-schema.ts, in the same migration,
-- separated by statement breakpoints as below.

CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor jsonb := nullif(current_setting('katasync.actor', true), '')::jsonb;
  old_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  keyed jsonb := coalesce(new_row, old_row);
  changed text[];
  resource jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}') INTO changed
      FROM jsonb_each(new_row) n
      WHERE n.value IS DISTINCT FROM old_row -> n.key;
    IF cardinality(changed) = 0 THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT jsonb_object_agg(k, keyed -> k) INTO resource FROM unnest(TG_ARGV) k;
  INSERT INTO audit_events (
    principal, staff_id, staff_name, staff_role, via_kind, via_id, via_name,
    system_name, operation, table_name, op, resource, changed_fields
  ) VALUES (
    coalesce(actor ->> 'kind', 'unattributed')::audit_principal,
    (actor ->> 'staff_id')::uuid,
    actor ->> 'staff_name',
    (actor ->> 'staff_role')::staff_role,
    (actor ->> 'via_kind')::audit_via,
    actor ->> 'via_id',
    actor ->> 'via_name',
    actor ->> 'system',
    actor ->> 'operation',
    TG_TABLE_NAME,
    lower(TG_OP)::audit_op,
    resource,
    changed
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION reject_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_change();
--> statement-breakpoint
CREATE TRIGGER movements_audit AFTER INSERT ON movements
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER products_audit AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER product_components_audit AFTER INSERT OR UPDATE OR DELETE ON product_components
  FOR EACH ROW EXECUTE FUNCTION audit_row('parent_product_id', 'component_product_id');
--> statement-breakpoint
CREATE TRIGGER transfers_audit AFTER INSERT OR UPDATE OR DELETE ON transfers
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER transfer_lines_audit AFTER INSERT OR UPDATE OR DELETE ON transfer_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER purchase_orders_audit AFTER INSERT OR UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER purchase_order_lines_audit AFTER INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER purchase_order_receipts_audit AFTER INSERT OR UPDATE OR DELETE ON purchase_order_receipts
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER dispatches_audit AFTER INSERT OR UPDATE OR DELETE ON dispatches
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER shipments_audit AFTER INSERT OR UPDATE OR DELETE ON shipments
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE OR DELETE ON staff
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER passkey_staff_audit AFTER INSERT OR UPDATE OR DELETE ON passkey_staff
  FOR EACH ROW EXECUTE FUNCTION audit_row('passkey_id', 'staff_id');
--> statement-breakpoint
CREATE TRIGGER oauth_grant_staff_audit AFTER INSERT OR DELETE ON oauth_grant_staff
  FOR EACH ROW EXECUTE FUNCTION audit_row('grant_id', 'staff_id');
--> statement-breakpoint
CREATE TRIGGER oauth_grants_audit AFTER INSERT OR DELETE ON oauth_grants
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER passkeys_audit AFTER DELETE ON passkeys
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE FUNCTION usable_owner_count() RETURNS bigint LANGUAGE sql VOLATILE AS $$
  SELECT count(*) FROM staff s
  WHERE s.role = 'owner' AND s.status = 'active'
    AND EXISTS (SELECT 1 FROM passkey_staff p WHERE p.staff_id = s.id)
$$;
--> statement-breakpoint
CREATE FUNCTION guard_last_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'staff' THEN
    IF NOT (OLD.role = 'owner' AND OLD.status = 'active') THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.role = 'owner' AND NEW.status = 'active' THEN
      RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM passkey_staff WHERE staff_id = OLD.id) THEN
      RETURN NULL;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.staff_id = OLD.staff_id THEN
      RETURN NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM staff WHERE id = OLD.staff_id AND role = 'owner' AND status = 'active'
    ) THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('katasync.staff.owners'));
  IF usable_owner_count() = 0 THEN
    RAISE EXCEPTION 'katasync needs an owner who can sign in' USING ERRCODE = 'KA001';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER staff_keep_owner AFTER UPDATE OR DELETE ON staff
  FOR EACH ROW EXECUTE FUNCTION guard_last_owner();
--> statement-breakpoint
CREATE TRIGGER passkey_staff_keep_owner AFTER UPDATE OR DELETE ON passkey_staff
  FOR EACH ROW EXECUTE FUNCTION guard_last_owner();
--> statement-breakpoint
UPDATE setup_links SET used_at = now()
  WHERE used_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM setup_link_scopes s WHERE s.token_hash = setup_links.token_hash);
--> statement-breakpoint
DELETE FROM auth_challenges
  WHERE NOT EXISTS (SELECT 1 FROM auth_challenge_bindings b WHERE b.challenge = auth_challenges.challenge);
--> statement-breakpoint
GRANT SELECT ON "staff", "audit_events" TO katasync_mcp;
