CREATE TYPE "public"."label_authority" AS ENUM('unknown', 'fallback', 'authoritative');--> statement-breakpoint
ALTER TABLE "order_cost_reports" ADD COLUMN "label_authority" "label_authority" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
-- Reports saved before this: a stand-in is a fallback, and label charges
-- from a report that wasn't one are authoritative. A report with neither
-- can't tell an authoritative $0 from no labels, so stays unknown.
UPDATE "order_cost_reports" SET "label_authority" = 'fallback' WHERE "labels_pending";--> statement-breakpoint
UPDATE "order_cost_reports" r SET "label_authority" = 'authoritative'
WHERE NOT r."labels_pending" AND EXISTS (
	SELECT 1 FROM "order_charges" c
	WHERE c."order_id" = r."order_id" AND c."billed_by" = r."billed_by" AND c."kind" = 'label'
);
