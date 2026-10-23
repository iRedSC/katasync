-- Custom migration to generate after report-schema.ts is registered:
--   pnpm db:generate --custom --name report_revisions_append_only
-- Saved revisions, their files and handoffs are append-only. Files may only
-- be added in the transaction that saved their revision, so a later render
-- can never join an old revision. A revision's as_of must be the time of the
-- transaction that read its figures.
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
      WHERE "id" = NEW."snapshot_id" AND "as_of" = now()) THEN
    RAISE EXCEPTION 'report_artifacts can only be added with their revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "report_artifacts_sealed" BEFORE INSERT ON "report_artifacts"
  FOR EACH ROW EXECUTE FUNCTION seal_report_artifact();
