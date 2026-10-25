CREATE TYPE "public"."case_escalation" AS ENUM('in_progress', 'buyer_won', 'seller_won', 'closed');--> statement-breakpoint
CREATE TYPE "public"."case_waiting_on" AS ENUM('us', 'buyer', 'marketplace', 'nobody');--> statement-breakpoint
ALTER TYPE "public"."return_request_status" ADD VALUE 'processing' BEFORE 'shipped';--> statement-breakpoint
ALTER TYPE "public"."return_request_status" ADD VALUE 'unknown' BEFORE 'shipped';--> statement-breakpoint
ALTER TABLE "return_requests" DROP CONSTRAINT "return_requests_refund_never_ships";--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "waiting_on" "case_waiting_on";--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "respond_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "next_action" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "amount" numeric;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "escalation" "case_escalation";--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "case_ref" text;--> statement-breakpoint
UPDATE "return_requests" SET "waiting_on" = CASE
 WHEN "status" IN ('closed', 'cancelled') THEN 'nobody'::case_waiting_on
 WHEN "billed_by" = 'tiktok' AND "raw_status" IN ('AWAITING_BUYER_SHIP', 'AWAITING_BUYER_RESPONSE') THEN 'buyer'::case_waiting_on
 WHEN "billed_by" = 'tiktok' AND "status" = 'requested'
  AND "raw_status" NOT IN ('RETURN_OR_REFUND_REQUEST_PENDING', 'REPLACEMENT_REQUEST_PENDING', 'EXCHANGE_REQUEST_PENDING') THEN 'marketplace'::case_waiting_on
 WHEN "status" = 'requested' AND "kind" = 'return' AND "billed_by" <> 'tiktok' THEN 'buyer'::case_waiting_on
 WHEN "status" IN ('requested', 'delivered') THEN 'us'::case_waiting_on
 ELSE 'marketplace'::case_waiting_on END;--> statement-breakpoint
ALTER TABLE "return_requests" ALTER COLUMN "waiting_on" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_resolved_owner" CHECK (("return_requests"."waiting_on" = 'nobody') = ("return_requests"."status" in ('closed', 'cancelled')));--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_deadline_owner" CHECK ("return_requests"."respond_by" is null or "return_requests"."waiting_on" = 'us');--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_money_pair" CHECK (("return_requests"."amount" is null) = ("return_requests"."currency" is null));--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_refund_never_ships" CHECK ("return_requests"."kind" = 'return' or "return_requests"."status"::text in ('requested', 'processing', 'unknown', 'closed', 'cancelled'));--> statement-breakpoint
CREATE VIEW "open_cases" AS
SELECT id, order_id, billed_by, external_id, case_ref, kind, status, waiting_on,
 respond_by, next_action, amount, currency, escalation
FROM return_requests WHERE waiting_on <> 'nobody'
ORDER BY respond_by NULLS LAST, id;--> statement-breakpoint
GRANT SELECT ON "open_cases" TO katasync_mcp;
