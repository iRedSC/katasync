CREATE TYPE "public"."commitment_entry_kind" AS ENUM('consume', 'release', 'restore');--> statement-breakpoint
CREATE TYPE "public"."commitment_source" AS ENUM('order', 'activation');--> statement-breakpoint
CREATE TYPE "public"."quantity_mode_kind" AS ENUM('legacy', 'committed');--> statement-breakpoint
CREATE TYPE "public"."shipment_evidence_kind" AS ENUM('shipped', 'voided');--> statement-breakpoint
CREATE TABLE "committed_stock" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "committed_stock_units" CHECK ("committed_stock"."units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quantity_mode" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" "quantity_mode_kind" DEFAULT 'legacy' NOT NULL,
	"activated_at" timestamp with time zone,
	"activation_report" jsonb,
	CONSTRAINT "quantity_mode_single" CHECK ("quantity_mode"."id" = 1),
	CONSTRAINT "quantity_mode_activated" CHECK (("quantity_mode"."mode" = 'committed') = ("quantity_mode"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "stock_commitment_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_commitment_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"commitment_id" integer NOT NULL,
	"kind" "commitment_entry_kind" NOT NULL,
	"quantity" integer NOT NULL,
	"fulfillment_key" text,
	"batch_id" uuid,
	"restores_entry_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_commitment_entries_fulfillment" UNIQUE("commitment_id","fulfillment_key"),
	CONSTRAINT "stock_commitment_entries_restores" UNIQUE("restores_entry_id"),
	CONSTRAINT "stock_commitment_entries_quantity" CHECK ("stock_commitment_entries"."quantity" > 0),
	CONSTRAINT "stock_commitment_entries_shape" CHECK (case "stock_commitment_entries"."kind"
				when 'consume' then "stock_commitment_entries"."fulfillment_key" is not null and "stock_commitment_entries"."batch_id" is not null and "stock_commitment_entries"."restores_entry_id" is null
				when 'release' then "stock_commitment_entries"."fulfillment_key" is null and "stock_commitment_entries"."batch_id" is null and "stock_commitment_entries"."restores_entry_id" is null
				else "stock_commitment_entries"."fulfillment_key" is null and "stock_commitment_entries"."batch_id" is not null and "stock_commitment_entries"."restores_entry_id" is not null
			end)
);
--> statement-breakpoint
CREATE TABLE "stock_commitment_parts" (
	"commitment_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"per_unit" integer NOT NULL,
	CONSTRAINT "stock_commitment_parts_commitment_id_product_id_pk" PRIMARY KEY("commitment_id","product_id"),
	CONSTRAINT "stock_commitment_parts_per_unit" CHECK ("stock_commitment_parts"."per_unit" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_commitments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_commitments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_line_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"revision" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"source" "commitment_source" NOT NULL,
	"legacy_sale_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_commitments_line_revision" UNIQUE("order_line_id","revision"),
	CONSTRAINT "stock_commitments_quantity" CHECK ("stock_commitments"."quantity" > 0),
	CONSTRAINT "stock_commitments_revision" CHECK ("stock_commitments"."revision" > 0),
	CONSTRAINT "stock_commitments_legacy_source" CHECK (("stock_commitments"."source" = 'activation') = ("stock_commitments"."legacy_sale_batch_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "transfer_dispatch_lines" (
	"dispatch_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "transfer_dispatch_lines_dispatch_id_product_id_pk" PRIMARY KEY("dispatch_id","product_id"),
	CONSTRAINT "transfer_dispatch_lines_quantity" CHECK ("transfer_dispatch_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "transfer_dispatches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfer_dispatches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"transfer_id" integer NOT NULL,
	"batch_id" uuid NOT NULL,
	"transit_location_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_dispatches_batchId_unique" UNIQUE("batch_id")
);
--> statement-breakpoint
CREATE TABLE "transfer_receipt_lines" (
	"receipt_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "transfer_receipt_lines_receipt_id_product_id_pk" PRIMARY KEY("receipt_id","product_id"),
	CONSTRAINT "transfer_receipt_lines_quantity" CHECK ("transfer_receipt_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "transfer_receipts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfer_receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"dispatch_id" integer NOT NULL,
	"receipt_key" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_receipts_batchId_unique" UNIQUE("batch_id"),
	CONSTRAINT "transfer_receipts_key" UNIQUE("dispatch_id","receipt_key")
);
--> statement-breakpoint
CREATE TABLE "unreserved_shipments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "unreserved_shipments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_line_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"kind" "shipment_evidence_kind" NOT NULL,
	"fulfillment_key" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unreserved_shipments_once" UNIQUE("order_line_id","fulfillment_key","kind"),
	CONSTRAINT "unreserved_shipments_quantity" CHECK ("unreserved_shipments"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "committed_stock" ADD CONSTRAINT "committed_stock_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_commitment_entries" ADD CONSTRAINT "stock_commitment_entries_commitment_id_stock_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."stock_commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_commitment_parts" ADD CONSTRAINT "stock_commitment_parts_commitment_id_stock_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."stock_commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_commitment_parts" ADD CONSTRAINT "stock_commitment_parts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_commitments" ADD CONSTRAINT "stock_commitments_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_commitments" ADD CONSTRAINT "stock_commitments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_commitments" ADD CONSTRAINT "stock_commitments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_dispatch_lines" ADD CONSTRAINT "transfer_dispatch_lines_dispatch_id_transfer_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."transfer_dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_dispatch_lines" ADD CONSTRAINT "transfer_dispatch_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_dispatches" ADD CONSTRAINT "transfer_dispatches_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_dispatches" ADD CONSTRAINT "transfer_dispatches_transit_location_id_locations_id_fk" FOREIGN KEY ("transit_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_receipt_lines" ADD CONSTRAINT "transfer_receipt_lines_receipt_id_transfer_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."transfer_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_receipt_lines" ADD CONSTRAINT "transfer_receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_receipts" ADD CONSTRAINT "transfer_receipts_dispatch_id_transfer_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."transfer_dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unreserved_shipments" ADD CONSTRAINT "unreserved_shipments_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unreserved_shipments" ADD CONSTRAINT "unreserved_shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_commitment_entries_commitment_idx" ON "stock_commitment_entries" USING btree ("commitment_id");--> statement-breakpoint
CREATE INDEX "stock_commitment_entries_key_idx" ON "stock_commitment_entries" USING btree ("fulfillment_key");--> statement-breakpoint
CREATE INDEX "stock_commitment_parts_product_idx" ON "stock_commitment_parts" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "stock_commitments_order_idx" ON "stock_commitments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "transfer_dispatches_transfer_idx" ON "transfer_dispatches" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "transfer_receipts_dispatch_idx" ON "transfer_receipts" USING btree ("dispatch_id");--> statement-breakpoint
CREATE INDEX "unreserved_shipments_order_idx" ON "unreserved_shipments" USING btree ("order_id");
--> statement-breakpoint
INSERT INTO "quantity_mode" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION keep_quantity_mode() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'the quantity mode row cannot be removed';
  END IF;
  IF OLD.mode = 'committed' AND NEW.mode <> 'committed' THEN
    RAISE EXCEPTION 'committed stock cannot return to legacy quantities';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER quantity_mode_keep BEFORE UPDATE OR DELETE ON quantity_mode
  FOR EACH ROW EXECUTE FUNCTION keep_quantity_mode();
--> statement-breakpoint
CREATE TRIGGER quantity_mode_keep_table BEFORE TRUNCATE ON quantity_mode
  FOR EACH STATEMENT EXECUTE FUNCTION keep_quantity_mode();
--> statement-breakpoint
CREATE FUNCTION reject_quantity_history_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; record a compensating entry instead', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitments_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "stock_commitments"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_parts_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "stock_commitment_parts"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_entries_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "stock_commitment_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "unreserved_shipments_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "unreserved_shipments"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE FUNCTION guard_unreserved_void() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" = 'voided' AND NOT EXISTS (
    SELECT 1 FROM "unreserved_shipments" s
    WHERE s."order_line_id" = NEW."order_line_id" AND s."fulfillment_key" = NEW."fulfillment_key"
      AND s."kind" = 'shipped' AND s."quantity" = NEW."quantity"
  ) THEN
    RAISE EXCEPTION 'void must match a shipment of order line % under %', NEW."order_line_id", NEW."fulfillment_key";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "unreserved_shipments_guard" BEFORE INSERT ON "unreserved_shipments"
  FOR EACH ROW EXECUTE FUNCTION guard_unreserved_void();
--> statement-breakpoint
CREATE TRIGGER "transfer_dispatches_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "transfer_dispatches"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "transfer_dispatch_lines_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "transfer_dispatch_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "transfer_receipts_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "transfer_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE TRIGGER "transfer_receipt_lines_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "transfer_receipt_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_quantity_history_change();
--> statement-breakpoint
CREATE FUNCTION commitment_settled(commitment integer) RETURNS integer AS $$
  SELECT coalesce(sum(CASE "kind" WHEN 'restore' THEN -"quantity" ELSE "quantity" END), 0)::int
  FROM "stock_commitment_entries" WHERE "commitment_id" = commitment;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE FUNCTION guard_commitment_revision() RETURNS trigger AS $$
DECLARE
  latest "stock_commitments"%ROWTYPE;
BEGIN
  SELECT * INTO latest FROM "stock_commitments"
  WHERE "order_line_id" = NEW."order_line_id"
  ORDER BY "revision" DESC LIMIT 1 FOR UPDATE;
  IF NEW."revision" <> coalesce(latest."revision", 0) + 1 THEN
    RAISE EXCEPTION 'commitment revision % for order line % is out of sequence', NEW."revision", NEW."order_line_id";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "stock_commitments" k
    WHERE k."order_line_id" = NEW."order_line_id" AND commitment_settled(k."id") < k."quantity"
  ) THEN
    RAISE EXCEPTION 'order line % still has an open commitment', NEW."order_line_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitments_revision" BEFORE INSERT ON "stock_commitments"
  FOR EACH ROW EXECUTE FUNCTION guard_commitment_revision();
--> statement-breakpoint
CREATE FUNCTION add_committed_part() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "stock_commitment_entries" WHERE "commitment_id" = NEW."commitment_id") THEN
    RAISE EXCEPTION 'commitment % already has entries; its parts are fixed', NEW."commitment_id";
  END IF;
  INSERT INTO "committed_stock" ("product_id", "units")
  SELECT NEW."product_id", NEW."per_unit" * c."quantity" FROM "stock_commitments" c WHERE c."id" = NEW."commitment_id"
  ON CONFLICT ("product_id") DO UPDATE SET "units" = "committed_stock"."units" + excluded."units";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_parts_total" AFTER INSERT ON "stock_commitment_parts"
  FOR EACH ROW EXECUTE FUNCTION add_committed_part();
--> statement-breakpoint
CREATE FUNCTION guard_commitment_entry() RETURNS trigger AS $$
DECLARE
  c "stock_commitments"%ROWTYPE;
  restored "stock_commitment_entries"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "stock_commitments" WHERE "id" = NEW."commitment_id" FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM "stock_commitment_parts" WHERE "commitment_id" = c."id") THEN
    RAISE EXCEPTION 'commitment % has no parts', c."id";
  END IF;
  IF NEW."kind" = 'restore' THEN
    SELECT * INTO restored FROM "stock_commitment_entries" WHERE "id" = NEW."restores_entry_id";
    IF restored."id" IS NULL OR restored."kind" <> 'consume' OR restored."commitment_id" <> c."id"
      OR restored."quantity" <> NEW."quantity" OR restored."batch_id" <> NEW."batch_id" THEN
      RAISE EXCEPTION 'restore must match a consume entry of commitment %', c."id";
    END IF;
  ELSIF commitment_settled(c."id") + NEW."quantity" > c."quantity" THEN
    RAISE EXCEPTION 'commitment % has only % left', c."id", c."quantity" - commitment_settled(c."id");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_entries_guard" BEFORE INSERT ON "stock_commitment_entries"
  FOR EACH ROW EXECUTE FUNCTION guard_commitment_entry();
--> statement-breakpoint
CREATE FUNCTION settle_committed_parts() RETURNS trigger AS $$
BEGIN
  UPDATE "committed_stock" s
  SET "units" = s."units" + p."per_unit" * NEW."quantity" * (CASE NEW."kind" WHEN 'restore' THEN 1 ELSE -1 END)
  FROM "stock_commitment_parts" p
  WHERE p."commitment_id" = NEW."commitment_id" AND s."product_id" = p."product_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "stock_commitment_entries_total" AFTER INSERT ON "stock_commitment_entries"
  FOR EACH ROW EXECUTE FUNCTION settle_committed_parts();
--> statement-breakpoint
CREATE FUNCTION guard_transfer_dispatch() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "locations" WHERE "id" = NEW."transit_location_id" AND "kind" = 'transit') THEN
    RAISE EXCEPTION 'location % is not a transit location', NEW."transit_location_id";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "transfers" WHERE "id" = NEW."transfer_id" AND "batch_id" = NEW."batch_id") THEN
    RAISE EXCEPTION 'dispatch batch must be transfer %''s sent batch', NEW."transfer_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "transfer_dispatches_guard" BEFORE INSERT ON "transfer_dispatches"
  FOR EACH ROW EXECUTE FUNCTION guard_transfer_dispatch();
--> statement-breakpoint
CREATE FUNCTION guard_transfer_receipt_line() RETURNS trigger AS $$
DECLARE
  dispatch integer;
  sent integer;
  received integer;
BEGIN
  SELECT r."dispatch_id" INTO dispatch FROM "transfer_receipts" r WHERE r."id" = NEW."receipt_id";
  PERFORM 1 FROM "transfer_dispatches" WHERE "id" = dispatch FOR UPDATE;
  SELECT "quantity" INTO sent FROM "transfer_dispatch_lines"
  WHERE "dispatch_id" = dispatch AND "product_id" = NEW."product_id";
  IF sent IS NULL THEN
    RAISE EXCEPTION 'product % was not sent on dispatch %', NEW."product_id", dispatch;
  END IF;
  SELECT coalesce(sum(l."quantity"), 0)::int INTO received
  FROM "transfer_receipt_lines" l
  JOIN "transfer_receipts" r ON r."id" = l."receipt_id"
  WHERE r."dispatch_id" = dispatch AND l."product_id" = NEW."product_id"
    AND NOT EXISTS (SELECT 1 FROM "movements" m WHERE m."reference" = 'undo:' || r."batch_id"::text);
  IF received + NEW."quantity" > sent THEN
    RAISE EXCEPTION 'only % of product % is still in transit', sent - received, NEW."product_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "transfer_receipt_lines_guard" BEFORE INSERT ON "transfer_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION guard_transfer_receipt_line();
