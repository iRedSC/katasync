CREATE TYPE "public"."audit_op" AS ENUM('insert', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."audit_principal" AS ENUM('staff', 'legacy', 'system', 'unattributed');--> statement-breakpoint
CREATE TYPE "public"."audit_via" AS ENUM('device', 'grant');--> statement-breakpoint
CREATE TYPE "public"."auth_challenge_purpose" AS ENUM('register', 'login');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('owner', 'operator');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"tx_id" bigint DEFAULT txid_current() NOT NULL,
	"principal" "audit_principal" NOT NULL,
	"staff_id" uuid,
	"staff_name" text,
	"staff_role" "staff_role",
	"via_kind" "audit_via",
	"via_id" text,
	"via_name" text,
	"system_name" text,
	"operation" text,
	"table_name" text NOT NULL,
	"op" "audit_op" NOT NULL,
	"resource" jsonb NOT NULL,
	"changed_fields" text[],
	CONSTRAINT "audit_events_principal_shape" CHECK (case "audit_events"."principal"
				when 'staff' then "audit_events"."staff_id" is not null and "audit_events"."staff_name" is not null and "audit_events"."staff_role" is not null and "audit_events"."via_kind" is not null and "audit_events"."system_name" is null
				when 'legacy' then "audit_events"."staff_id" is null and "audit_events"."staff_role" is null and "audit_events"."via_kind" is not null and "audit_events"."system_name" is null
				when 'system' then "audit_events"."staff_id" is null and "audit_events"."staff_role" is null and "audit_events"."via_kind" is null and "audit_events"."system_name" is not null
				else "audit_events"."staff_id" is null and "audit_events"."staff_role" is null and "audit_events"."via_kind" is null and "audit_events"."system_name" is null
			end),
	CONSTRAINT "audit_events_via_shape" CHECK (("audit_events"."via_kind" is null) = ("audit_events"."via_id" is null) and ("audit_events"."via_kind" is null) = ("audit_events"."via_name" is null))
);
--> statement-breakpoint
CREATE TABLE "auth_challenge_bindings" (
	"challenge" text PRIMARY KEY NOT NULL,
	"purpose" "auth_challenge_purpose" NOT NULL,
	"setup_token_hash" text,
	CONSTRAINT "auth_challenge_bindings_shape" CHECK (("auth_challenge_bindings"."purpose" = 'register') = ("auth_challenge_bindings"."setup_token_hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "oauth_grant_staff" (
	"grant_id" uuid PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"passkey_id" text
);
--> statement-breakpoint
CREATE TABLE "passkey_staff" (
	"passkey_id" text PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_link_scopes" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"issued_by_staff_id" uuid,
	"issued_by_system" text,
	CONSTRAINT "setup_link_scopes_one_issuer" CHECK (("setup_link_scopes"."issued_by_staff_id" is null) <> ("setup_link_scopes"."issued_by_system" is null))
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"status" "staff_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_name_present" CHECK (length(trim("staff"."name")) between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "auth_challenge_bindings" ADD CONSTRAINT "auth_challenge_bindings_challenge_auth_challenges_challenge_fk" FOREIGN KEY ("challenge") REFERENCES "public"."auth_challenges"("challenge") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant_staff" ADD CONSTRAINT "oauth_grant_staff_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant_staff" ADD CONSTRAINT "oauth_grant_staff_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant_staff" ADD CONSTRAINT "oauth_grant_staff_passkey_id_passkeys_id_fk" FOREIGN KEY ("passkey_id") REFERENCES "public"."passkeys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_staff" ADD CONSTRAINT "passkey_staff_passkey_id_passkeys_id_fk" FOREIGN KEY ("passkey_id") REFERENCES "public"."passkeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_staff" ADD CONSTRAINT "passkey_staff_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_link_scopes" ADD CONSTRAINT "setup_link_scopes_token_hash_setup_links_token_hash_fk" FOREIGN KEY ("token_hash") REFERENCES "public"."setup_links"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_link_scopes" ADD CONSTRAINT "setup_link_scopes_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_link_scopes" ADD CONSTRAINT "setup_link_scopes_issued_by_staff_id_staff_id_fk" FOREIGN KEY ("issued_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_staff_idx" ON "audit_events" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("table_name","resource");--> statement-breakpoint
CREATE INDEX "oauth_grant_staff_staff_idx" ON "oauth_grant_staff" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "passkey_staff_staff_idx" ON "passkey_staff" USING btree ("staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_name_unique" ON "staff" USING btree (lower("name"));
--> statement-breakpoint
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
CREATE TRIGGER report_snapshots_audit AFTER INSERT ON report_snapshots
  FOR EACH ROW EXECUTE FUNCTION audit_row('id');
--> statement-breakpoint
CREATE TRIGGER report_handoffs_audit AFTER INSERT ON report_handoffs
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
