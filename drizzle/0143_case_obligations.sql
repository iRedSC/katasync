CREATE TYPE "public"."case_escalation" AS ENUM('in_progress', 'buyer_won', 'seller_won', 'closed');--> statement-breakpoint
CREATE TYPE "public"."case_waiting_on" AS ENUM('us', 'buyer', 'marketplace', 'nobody');--> statement-breakpoint
ALTER TABLE "return_requests" DROP CONSTRAINT "return_requests_refund_never_ships";--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "waiting_on" "case_waiting_on";--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "respond_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "next_action" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "amount" numeric;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "escalation" "case_escalation";--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "case_ref" text;--> statement-breakpoint
UPDATE "return_requests" SET "status" = (CASE "raw_status"
 WHEN 'RETURN_OR_REFUND_REQUEST_PENDING' THEN 'requested'
 WHEN 'REFUND_OR_RETURN_REQUEST_REJECT' THEN 'cancelled'
 WHEN 'AWAITING_BUYER_SHIP' THEN 'requested'
 WHEN 'BUYER_SHIPPED_ITEM' THEN 'shipped'
 WHEN 'REJECT_RECEIVE_PACKAGE' THEN 'cancelled'
 WHEN 'RETURN_OR_REFUND_REQUEST_SUCCESS' THEN 'processing'
 WHEN 'RETURN_OR_REFUND_REQUEST_CANCEL' THEN 'cancelled'
 WHEN 'RETURN_OR_REFUND_REQUEST_COMPLETE' THEN 'closed'
 WHEN 'AWAITING_BUYER_RESPONSE' THEN 'requested'
 WHEN 'REPLACEMENT_REQUEST_PENDING' THEN 'requested'
 WHEN 'REPLACEMENT_REQUEST_REJECT' THEN 'cancelled'
 WHEN 'REPLACEMENT_REQUEST_REFUND_SUCCESS' THEN 'processing'
 WHEN 'REPLACEMENT_REQUEST_CANCEL' THEN 'cancelled'
 WHEN 'REPLACEMENT_REQUEST_COMPLETE' THEN 'closed'
 WHEN 'EXCHANGE_REQUEST_PENDING' THEN 'requested'
 WHEN 'EXCHANGE_REQUEST_REFUND_SUCCESS' THEN 'processing'
 WHEN 'EXCHANGE_REQUEST_CANCEL' THEN 'cancelled'
 WHEN 'EXCHANGE_REQUEST_COMPLETE' THEN 'closed'
 ELSE 'unknown' END)::return_request_status
WHERE "billed_by" = 'tiktok';--> statement-breakpoint
UPDATE "return_requests" SET "status" = (CASE "raw_status"
 WHEN 'AUTO_REFUND_INITIATED' THEN 'processing'
 WHEN 'CLOSED' THEN 'closed'
 WHEN 'INITIAL' THEN 'unknown'
 WHEN 'ITEM_DELIVERED' THEN 'delivered'
 WHEN 'ITEM_KEPT' THEN 'requested'
 WHEN 'ITEM_READY_TO_SHIP' THEN 'requested'
 WHEN 'ITEM_SHIPPED' THEN 'shipped'
 WHEN 'LESS_THAN_A_FULL_REFUND_ISSUED' THEN 'unknown'
 WHEN 'PARTIAL_REFUND_AS_PAYOUT_INITIATED' THEN 'processing'
 WHEN 'PARTIAL_REFUND_DECLINED' THEN 'requested'
 WHEN 'PARTIAL_REFUND_FAILED' THEN 'processing'
 WHEN 'PARTIAL_REFUND_INITIATED' THEN 'processing'
 WHEN 'PARTIAL_REFUND_NON_PAYPAL_INITIATED' THEN 'processing'
 WHEN 'PARTIAL_REFUND_REQUESTED' THEN 'requested'
 WHEN 'PARTIAL_REFUNDED' THEN 'unknown'
 WHEN 'PAYOUT_INITIATED' THEN 'unknown'
 WHEN 'REFUND_AS_PAYOUT_INITIATED' THEN 'processing'
 WHEN 'REFUND_FAILED' THEN 'processing'
 WHEN 'REFUND_INITIATED' THEN 'processing'
 WHEN 'REFUND_SENT_PENDING_CONFIRMATION' THEN 'processing'
 WHEN 'REFUND_TIMEOUT' THEN 'processing'
 WHEN 'REPLACED' THEN 'unknown'
 WHEN 'REPLACEMENT_CLOSED' THEN 'closed'
 WHEN 'REPLACEMENT_DELIVERED' THEN 'unknown'
 WHEN 'REPLACEMENT_LABEL_PENDING' THEN 'unknown'
 WHEN 'REPLACEMENT_LABEL_PENDING_TIMEOUT' THEN 'unknown'
 WHEN 'REPLACEMENT_LABEL_REQUESTED' THEN 'unknown'
 WHEN 'REPLACEMENT_LABEL_REQUESTED_TIMEOUT' THEN 'unknown'
 WHEN 'REPLACEMENT_OFFER_PENDING' THEN 'unknown'
 WHEN 'REPLACEMENT_REQUEST_TIMEOUT' THEN 'unknown'
 WHEN 'REPLACEMENT_REQUESTED' THEN 'unknown'
 WHEN 'REPLACEMENT_RMA_PENDING' THEN 'unknown'
 WHEN 'REPLACEMENT_SHIPPED' THEN 'unknown'
 WHEN 'REPLACEMENT_STARTED' THEN 'unknown'
 WHEN 'RETURN_LABEL_PENDING' THEN 'unknown'
 WHEN 'RETURN_LABEL_PENDING_TIMEOUT' THEN 'unknown'
 WHEN 'RETURN_LABEL_REQUESTED' THEN 'unknown'
 WHEN 'RETURN_LABEL_REQUESTED_TIMEOUT' THEN 'unknown'
 WHEN 'RETURN_REJECTED' THEN 'cancelled'
 WHEN 'RETURN_REQUEST_TIMEOUT' THEN 'unknown'
 WHEN 'RETURN_REQUESTED' THEN 'requested'
 WHEN 'RMA_PENDING' THEN 'requested'
 WHEN 'UNKNOWN' THEN 'unknown'
 ELSE 'unknown' END)::return_request_status
WHERE "billed_by" = 'ebay';--> statement-breakpoint
UPDATE "return_requests" SET "status" = (CASE "raw_status"
 WHEN 'REQUESTED' THEN 'requested'
 WHEN 'OPEN' THEN 'requested'
 WHEN 'CLOSED' THEN 'closed'
 WHEN 'CANCELED' THEN 'cancelled'
 WHEN 'DECLINED' THEN 'cancelled'
 ELSE 'unknown' END)::return_request_status
WHERE "billed_by" = 'shopify';--> statement-breakpoint
UPDATE "return_requests" SET "status" = (CASE
 WHEN lower(trim("raw_status")) IN ('cancelled', 'canceled', 'rejected') THEN 'cancelled'
 WHEN lower(trim("raw_status")) = 'closed' THEN 'closed'
 WHEN "status" = 'delivered' THEN 'delivered'
 WHEN coalesce("tracking_number", '') <> '' THEN 'shipped'
 WHEN lower(trim("raw_status")) = 'approved' THEN 'requested'
 ELSE 'unknown' END)::return_request_status WHERE "billed_by" = 'amazon';--> statement-breakpoint
UPDATE "return_requests" SET "status" = 'shipped'
WHERE "billed_by" = 'shopify' AND "raw_status" = 'OPEN' AND coalesce("tracking_number", '') <> '';--> statement-breakpoint
UPDATE "return_requests" SET "status" = 'unknown'
WHERE "kind" = 'refund' AND "status" IN ('shipped', 'delivered');--> statement-breakpoint
UPDATE "return_requests" SET "waiting_on" = CASE
 WHEN "status" IN ('closed', 'cancelled') THEN 'nobody'::case_waiting_on
 WHEN "billed_by" = 'tiktok' AND "raw_status" IN ('RETURN_OR_REFUND_REQUEST_PENDING', 'REPLACEMENT_REQUEST_PENDING', 'EXCHANGE_REQUEST_PENDING') AND "status" NOT IN ('unknown', 'shipped') THEN 'us'::case_waiting_on
 WHEN "billed_by" = 'tiktok' AND "raw_status" IN ('AWAITING_BUYER_SHIP', 'AWAITING_BUYER_RESPONSE') AND "status" NOT IN ('unknown', 'shipped') THEN 'buyer'::case_waiting_on
 WHEN "billed_by" = 'ebay' AND "raw_status" IN ('ITEM_DELIVERED', 'ITEM_KEPT', 'PARTIAL_REFUND_DECLINED', 'PARTIAL_REFUND_FAILED', 'PARTIAL_REFUND_REQUESTED', 'REFUND_FAILED', 'REFUND_TIMEOUT', 'RETURN_REQUESTED', 'RMA_PENDING') AND "status" NOT IN ('unknown', 'shipped') THEN 'us'::case_waiting_on
 WHEN "billed_by" = 'ebay' AND "raw_status" IN ('ITEM_READY_TO_SHIP', 'REFUND_SENT_PENDING_CONFIRMATION') AND "status" NOT IN ('unknown', 'shipped') THEN 'buyer'::case_waiting_on
 WHEN "billed_by" = 'shopify' AND "raw_status" IN ('REQUESTED') AND "status" NOT IN ('unknown', 'shipped') THEN 'us'::case_waiting_on
 WHEN "billed_by" = 'shopify' AND "raw_status" IN ('OPEN') AND "status" NOT IN ('unknown', 'shipped') THEN 'buyer'::case_waiting_on
 WHEN "billed_by" = 'amazon' AND "status" = 'delivered' THEN 'us'::case_waiting_on
 WHEN "billed_by" = 'amazon' AND "status" = 'requested' AND lower(trim("raw_status")) = 'approved' THEN 'buyer'::case_waiting_on
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
