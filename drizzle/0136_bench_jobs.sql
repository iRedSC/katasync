CREATE TYPE "public"."repair_kind" AS ENUM('customer', 'bench');--> statement-breakpoint
ALTER TYPE "public"."repair_status" ADD VALUE 'refurbished';--> statement-breakpoint
ALTER TABLE "repairs" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repairs" ALTER COLUMN "customer_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repairs" ADD COLUMN "kind" "repair_kind" DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "repairs" ADD COLUMN "product_id" integer;--> statement-breakpoint
ALTER TABLE "repairs" ADD COLUMN "return_line_id" integer;--> statement-breakpoint
ALTER TABLE "repairs" ADD COLUMN "refurb_product_id" integer;--> statement-breakpoint
ALTER TABLE "repairs" ADD COLUMN "parts_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_return_line_id_order_lines_id_fk" FOREIGN KEY ("return_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_refurb_product_id_products_id_fk" FOREIGN KEY ("refurb_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repairs_return_line_idx" ON "repairs" USING btree ("return_line_id") WHERE "repairs"."return_line_id" is not null;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_customer_by_kind" CHECK (case "repairs"."kind"::text
				when 'customer' then "repairs"."customer_id" is not null and "repairs"."customer_name" is not null
					and "repairs"."return_line_id" is null and "repairs"."refurb_product_id" is null
					and "repairs"."status"::text <> 'refurbished'
				else "repairs"."customer_id" is null and "repairs"."customer_name" is null
					and "repairs"."customer_phone" is null and "repairs"."customer_email" is null
					and "repairs"."draft_order_id" is null and "repairs"."order_id" is null
					and "repairs"."product_id" is not null and "repairs"."status"::text <> 'picked_up'
			end);--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_refurb_when_refurbished" CHECK (("repairs"."status"::text = 'refurbished') = ("repairs"."refurb_product_id" is not null));--> statement-breakpoint
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
	WHERE rr."status" IN ('requested', 'shipped', 'delivered')
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
