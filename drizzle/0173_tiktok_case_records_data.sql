-- Shopify's and TikTok's saves so far carried the marketplace's own time.
UPDATE "return_requests" SET "source_versioned" = true WHERE "billed_by" IN ('shopify', 'tiktok');--> statement-breakpoint
-- Every TikTok case so far kept only a note: read its records, a batch a pass.
-- note_unread is left as it was, for the code from before records.
UPDATE "return_requests" SET "records_unread" = true WHERE "billed_by" = 'tiktok';--> statement-breakpoint
CREATE VIEW "return_request_evidence" AS
SELECT "id", "request_id", "record_id", "position", "kind", "copy", "width", "height", "duration_ms"
FROM "return_request_media";--> statement-breakpoint
-- The media's signed links and bytes aren't the query tool's
-- (SECRET_TABLES in src/mcp/query.ts); what's there, and in what state, is.
GRANT SELECT ON "return_request_records", "return_request_evidence" TO katasync_mcp;--> statement-breakpoint
REVOKE ALL ON "return_request_media" FROM katasync_mcp;
