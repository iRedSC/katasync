CREATE TYPE "public"."return_request_kind" AS ENUM('return', 'refund');--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "kind" "return_request_kind" DEFAULT 'return' NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_refund_never_ships" CHECK ("return_requests"."kind" = 'return' or "return_requests"."status" in ('requested', 'closed', 'cancelled'));--> statement-breakpoint
-- TikTok refunds with nothing coming back were saved closed while still
-- waiting on our answer: closed beside a raw status that isn't. They're
-- refunds, and still requested. Settled ones become refunds as the next
-- returns history pass rereads them.
UPDATE "return_requests" SET "kind" = 'refund', "status" = 'requested'
WHERE "billed_by" = 'tiktok' AND "status" = 'closed'
	AND "raw_status" NOT LIKE '%COMPLETE%' AND "raw_status" NOT LIKE '%SUCCESS%';
--> statement-breakpoint
-- As in 0136, but a refund is never due back: nothing's coming.
CREATE OR REPLACE VIEW "order_returns_due" AS
WITH received AS (
	SELECT "order_line_id", sum("quantity") AS "returned"
	FROM "order_returns" GROUP BY "order_line_id"
),
-- Units back and on the bench, not yet received: each open bench job holds
-- one (src/repairs/bench.ts). They're here, so not due.
held AS (
	SELECT "return_line_id" AS "order_line_id", count(*) AS "held"
	FROM "repairs"
	WHERE "return_line_id" IS NOT NULL
		AND "status"::text IN ('received', 'waiting_parts', 'in_repair', 'ready')
	GROUP BY "return_line_id"
),
open_requests AS (
	SELECT rr."id", rr."order_id", rr."status", rr."tracking_number"
	FROM "return_requests" rr
	JOIN "orders" o ON o."id" = rr."order_id"
	WHERE rr."kind" = 'return'
		AND rr."status" IN ('requested', 'shipped', 'delivered')
		AND (o."no_return_at" IS NULL OR rr."requested_at" > o."no_return_at")
),
requested AS (
	SELECT rl."order_line_id",
		sum(rl."quantity") AS "quantity",
		bool_or(r."status" <> 'requested' OR r."tracking_number" IS NOT NULL) AS "sent"
	FROM "return_request_lines" rl
	JOIN open_requests r ON r."id" = rl."request_id"
	WHERE rl."order_line_id" IS NOT NULL
	GROUP BY rl."order_line_id"
),
-- Orders with an open request for an item no line matched.
unmatched AS (
	SELECT r."order_id",
		bool_or(r."status" <> 'requested' OR r."tracking_number" IS NOT NULL) AS "sent"
	FROM "return_request_lines" rl
	JOIN open_requests r ON r."id" = rl."request_id"
	WHERE rl."order_line_id" IS NULL
	GROUP BY r."order_id"
),
-- Refunds as order_profit counts them: only from where it really sold.
refunds AS (
	SELECT ch."order_id", sum(ch."amount") AS "amount"
	FROM "order_charges" ch
	JOIN "orders" o ON o."id" = ch."order_id"
	JOIN "stores" st ON st."id" = o."store_id"
	WHERE ch."kind" = 'refund'
		AND ch."billed_by" = coalesce(split_part(o."marketplace_order_id", ':', 1)::"channel", st."channel")
	GROUP BY ch."order_id"
),
lines AS (
	SELECT
		l."id" AS "line_id",
		l."order_id",
		l."quantity" - coalesce(rc."returned", 0) - coalesce(h."held", 0) AS "left",
		greatest(least(coalesce(rq."quantity", 0), l."quantity") - coalesce(rc."returned", 0) - coalesce(h."held", 0), 0) AS "requested",
		coalesce(rq."sent", false) AS "sent",
		um."order_id" IS NOT NULL AS "unmatched",
		coalesce(um."sent", false) AS "unmatched_sent",
		greatest(lc."returning" - coalesce(h."held", 0), 0) AS "returning",
		coalesce(rc."returned", 0) + coalesce(h."held", 0) AS "returned",
		o."no_return_at",
		o."placed_at",
		coalesce(rf."amount", 0) AS "refunds"
	FROM "order_lines" l
	JOIN "orders" o ON o."id" = l."order_id"
	JOIN "order_line_costs" lc ON lc."line_id" = l."id"
	LEFT JOIN received rc ON rc."order_line_id" = l."id"
	LEFT JOIN held h ON h."order_line_id" = l."id"
	LEFT JOIN requested rq ON rq."order_line_id" = l."id"
	LEFT JOIN unmatched um ON um."order_id" = l."order_id"
	LEFT JOIN refunds rf ON rf."order_id" = l."order_id"
	WHERE lc."from_shelf"
		AND NOT o."fulfilled_by_channel" AND o."cancelled_at" IS NULL
),
states AS (
	SELECT "order_id",
		-- An unmatched item counts only while some line still has units left.
		bool_or("unmatched" AND "left" > 0) AS "unmatched",
		CASE
			WHEN bool_or("requested" > 0 AND "sent")
				OR bool_or("unmatched" AND "unmatched_sent" AND "left" > 0) THEN 'on_its_way'
			WHEN bool_or("requested" > 0)
				OR bool_or("unmatched" AND "left" > 0) THEN 'requested'
			WHEN bool_or("returning" > 0) THEN 'refunded'
			WHEN max("refunds") > 0 AND sum("returned") = 0 AND bool_or("left" > 0)
				AND max("no_return_at") IS NULL
				AND max("placed_at") >= now() - interval '60 days' THEN 'maybe'
		END AS "state"
	FROM lines GROUP BY "order_id"
)
SELECT
	l."line_id",
	l."order_id",
	s."state",
	-- Units expected back. A maybe is only a guess: up to what's left.
	(CASE s."state"
		WHEN 'maybe' THEN l."left"
		ELSE greatest(l."requested", l."returning")
	END)::int AS "expected"
FROM lines l
JOIN states s ON s."order_id" = l."order_id"
WHERE s."state" IS NOT NULL
	AND ((CASE s."state"
		WHEN 'maybe' THEN l."left"
		ELSE greatest(l."requested", l."returning")
	END) > 0
		OR (s."unmatched" AND l."left" > 0));
