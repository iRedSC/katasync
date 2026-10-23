CREATE TYPE "public"."report_kind" AS ENUM('sales_tax_month');--> statement-breakpoint
CREATE TABLE "report_artifacts" (
	"snapshot_id" integer NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "report_artifacts_snapshot_id_name_pk" PRIMARY KEY("snapshot_id","name")
);
--> statement-breakpoint
CREATE TABLE "report_handoffs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "report_handoffs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"snapshot_id" integer NOT NULL,
	"digest" text NOT NULL,
	"recipient" text NOT NULL,
	"note" text,
	"handed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "report_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" "report_kind" NOT NULL,
	"period" text NOT NULL,
	"revision" integer NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"schema_version" integer NOT NULL,
	"renderer_version" integer NOT NULL,
	"currency" text NOT NULL,
	"time_zone" text NOT NULL,
	"source" text NOT NULL,
	"data" jsonb NOT NULL,
	"data_digest" text NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "report_snapshots_revision" UNIQUE("kind","period","revision"),
	CONSTRAINT "report_snapshots_digest" UNIQUE("digest"),
	CONSTRAINT "report_snapshots_id_digest" UNIQUE("id","digest")
);
--> statement-breakpoint
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_snapshot_id_report_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."report_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_handoffs" ADD CONSTRAINT "report_handoffs_revision_fk" FOREIGN KEY ("snapshot_id","digest") REFERENCES "public"."report_snapshots"("id","digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_handoffs_snapshot_idx" ON "report_handoffs" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "report_snapshots_period_idx" ON "report_snapshots" USING btree ("kind","period");
--> statement-breakpoint
CREATE FUNCTION keep_report_rows() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; save a new revision instead', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "report_snapshots_append_only" BEFORE UPDATE OR DELETE ON "report_snapshots"
  FOR EACH ROW EXECUTE FUNCTION keep_report_rows();
--> statement-breakpoint
CREATE TRIGGER "report_artifacts_append_only" BEFORE UPDATE OR DELETE ON "report_artifacts"
  FOR EACH ROW EXECUTE FUNCTION keep_report_rows();
--> statement-breakpoint
CREATE TRIGGER "report_handoffs_append_only" BEFORE UPDATE OR DELETE ON "report_handoffs"
  FOR EACH ROW EXECUTE FUNCTION keep_report_rows();
--> statement-breakpoint
CREATE TRIGGER "report_snapshots_no_truncate" BEFORE TRUNCATE ON "report_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION keep_report_rows();
--> statement-breakpoint
CREATE TRIGGER "report_artifacts_no_truncate" BEFORE TRUNCATE ON "report_artifacts"
  FOR EACH STATEMENT EXECUTE FUNCTION keep_report_rows();
--> statement-breakpoint
CREATE TRIGGER "report_handoffs_no_truncate" BEFORE TRUNCATE ON "report_handoffs"
  FOR EACH STATEMENT EXECUTE FUNCTION keep_report_rows();
--> statement-breakpoint
CREATE FUNCTION seal_report_snapshot() RETURNS trigger AS $$
BEGIN
  IF NEW."as_of" <> now() THEN
    RAISE EXCEPTION 'report_snapshots.as_of must be the saving transaction''s time';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "report_snapshots_sealed" BEFORE INSERT ON "report_snapshots"
  FOR EACH ROW EXECUTE FUNCTION seal_report_snapshot();
--> statement-breakpoint
CREATE FUNCTION seal_report_artifact() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "report_snapshots"
      WHERE "id" = NEW."snapshot_id" AND xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'report_artifacts can only be added with their revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "report_artifacts_sealed" BEFORE INSERT ON "report_artifacts"
  FOR EACH ROW EXECUTE FUNCTION seal_report_artifact();
--> statement-breakpoint
GRANT SELECT ON "report_snapshots", "report_artifacts", "report_handoffs" TO katasync_mcp;
