CREATE TABLE "dispatch_lines" (
	"dispatch_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"line_external_id" text NOT NULL,
	"product_id" integer,
	"sku" text,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "dispatch_lines_dispatch_id_order_id_line_external_id_pk" PRIMARY KEY("dispatch_id","order_id","line_external_id"),
	CONSTRAINT "dispatch_lines_quantity_positive" CHECK ("dispatch_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "label_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dispatch_id" integer NOT NULL,
	"box_index" integer NOT NULL,
	"provider" text NOT NULL,
	"rate_id" text NOT NULL,
	"unit_ids" text[],
	"box" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"shipment_id" integer,
	"error" text,
	"last_lookup" text,
	"checked_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_attempts_shipmentId_unique" UNIQUE("shipment_id"),
	CONSTRAINT "label_attempts_box" UNIQUE("dispatch_id","box_index"),
	CONSTRAINT "label_attempts_state_known" CHECK ("label_attempts"."state" in ('pending', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "label_attempts_provider_known" CHECK ("label_attempts"."provider" in ('shippo', 'tiktok')),
	CONSTRAINT "label_attempts_shipment_iff_succeeded" CHECK (("label_attempts"."state" = 'succeeded') = ("label_attempts"."shipment_id" is not null)),
	CONSTRAINT "label_attempts_settled_iff_final" CHECK (("label_attempts"."state" in ('succeeded', 'failed')) = ("label_attempts"."settled_at" is not null)),
	CONSTRAINT "label_attempts_failed_says_why" CHECK ("label_attempts"."state" <> 'failed' or "label_attempts"."error" is not null),
	CONSTRAINT "label_attempts_lookup_when_unknown" CHECK ("label_attempts"."last_lookup" is null or ("label_attempts"."state" in ('unknown', 'failed') and "label_attempts"."checked_at" is not null)),
	CONSTRAINT "label_attempts_box_index" CHECK ("label_attempts"."box_index" >= 0),
	CONSTRAINT "label_attempts_tiktok_units" CHECK (("label_attempts"."provider" = 'tiktok') = ("label_attempts"."unit_ids" is not null and cardinality("label_attempts"."unit_ids") > 0))
);
--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD COLUMN "handoff_hold" jsonb;--> statement-breakpoint
ALTER TABLE "dispatches" ADD COLUMN "contents" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatches" ADD COLUMN "box_count" integer;--> statement-breakpoint
ALTER TABLE "dispatch_lines" ADD CONSTRAINT "dispatch_lines_member_fk" FOREIGN KEY ("dispatch_id","order_id") REFERENCES "public"."dispatch_orders"("dispatch_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_attempts" ADD CONSTRAINT "label_attempts_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_attempts" ADD CONSTRAINT "label_attempts_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_lines_order_line_idx" ON "dispatch_lines" USING btree ("order_id","line_external_id");--> statement-breakpoint
CREATE INDEX "label_attempts_open_idx" ON "label_attempts" USING btree ("dispatch_id") WHERE "label_attempts"."state" in ('pending', 'unknown');--> statement-breakpoint
ALTER TABLE "dispatch_orders" ADD CONSTRAINT "dispatch_orders_hold_unsent" CHECK ("dispatch_orders"."handoff_hold" is null or ("dispatch_orders"."channel_sent_at" is null and "dispatch_orders"."channel_retry_at" is null));--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_contents_known" CHECK ("dispatches"."contents" in ('packed', 'unknown'));--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_packed_box_count" CHECK (("dispatches"."contents" = 'packed') = ("dispatches"."box_count" is not null and "dispatches"."box_count" > 0));
--> statement-breakpoint
CREATE FUNCTION reject_dispatch_line_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dispatch_lines are the record of what was packed; they never change';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER dispatch_lines_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON dispatch_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_dispatch_line_change();
--> statement-breakpoint
CREATE FUNCTION check_dispatch_line_packed() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM dispatches d WHERE d.id = NEW.dispatch_id AND d.contents = 'packed'
  ) THEN
    RAISE EXCEPTION 'dispatch % has unknown contents; it takes no lines', NEW.dispatch_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER dispatch_lines_packed_only
  BEFORE INSERT ON dispatch_lines
  FOR EACH ROW EXECUTE FUNCTION check_dispatch_line_packed();
--> statement-breakpoint
CREATE FUNCTION check_packed_dispatch_has_lines() RETURNS trigger AS $$
BEGIN
  IF NEW.contents = 'packed' AND NOT EXISTS (
    SELECT 1 FROM dispatch_lines l WHERE l.dispatch_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'packed dispatch % has no lines', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER dispatches_packed_has_lines
  AFTER INSERT ON dispatches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_packed_dispatch_has_lines();
--> statement-breakpoint
CREATE FUNCTION reject_dispatch_contents_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a dispatch''s contents and box count never change';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER dispatches_contents_fixed
  BEFORE UPDATE ON dispatches
  FOR EACH ROW
  WHEN (OLD.contents IS DISTINCT FROM NEW.contents OR OLD.box_count IS DISTINCT FROM NEW.box_count)
  EXECUTE FUNCTION reject_dispatch_contents_change();
--> statement-breakpoint
CREATE FUNCTION check_label_attempt_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'label attempts are kept; settle them instead';
  END IF;
  IF OLD.state IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'label attempt % is already %', OLD.id, OLD.state;
  END IF;
  IF NEW.state = 'pending' AND OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'label attempt % can''t go back to pending', OLD.id;
  END IF;
  IF (NEW.id, NEW.dispatch_id, NEW.box_index, NEW.provider, NEW.rate_id, NEW.unit_ids, NEW.box, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.dispatch_id, OLD.box_index, OLD.provider, OLD.rate_id, OLD.unit_ids, OLD.box, OLD.created_at) THEN
    RAISE EXCEPTION 'what label attempt % bought never changes', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER label_attempts_transitions
  BEFORE UPDATE OR DELETE ON label_attempts
  FOR EACH ROW EXECUTE FUNCTION check_label_attempt_transition();
--> statement-breakpoint
GRANT SELECT ON "dispatch_lines" TO katasync_mcp;--> statement-breakpoint
GRANT SELECT ON "label_attempts" TO katasync_mcp;
