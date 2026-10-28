CREATE OR REPLACE VIEW "order_line_returns" AS
WITH received AS (
	SELECT "order_line_id",
		sum("quantity") AS "received",
		sum("quantity") FILTER (WHERE "restocked") AS "restocked"
	FROM "order_returns" GROUP BY "order_line_id"
),
requested AS (
	SELECT rl."order_line_id",
		sum(rl."quantity") AS "requested",
		-- Each item's own reason, where the marketplace gave one (Amazon).
		array_agg(DISTINCT coalesce(rl."reason", rr."reason")) FILTER (WHERE coalesce(rl."reason", rr."reason") IS NOT NULL) AS "reasons"
	FROM "return_request_lines" rl
	JOIN "return_requests" rr ON rr."id" = rl."request_id"
	WHERE rr."status" <> 'cancelled' AND rl."order_line_id" IS NOT NULL
	GROUP BY rl."order_line_id"
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
order_revenue AS (
	SELECT "order_id", sum("unit_price" * "quantity") AS "revenue"
	FROM "order_lines" GROUP BY "order_id"
),
lines AS (
	SELECT
		l."id" AS "line_id",
		l."order_id",
		l."product_id",
		coalesce(split_part(o."marketplace_order_id", ':', 1)::"channel", st."channel") AS "sold_on",
		o."placed_at",
		l."quantity" AS "sold",
		coalesce(rc."received", 0)::int AS "received",
		coalesce(rc."restocked", 0)::int AS "restocked",
		least(coalesce(rq."requested", 0), l."quantity")::int AS "requested",
		(rv."revenue" > 0 AND coalesce(rf."amount", 0) >= rv."revenue" + o."shipping_charged") AS "refunded_in_full",
		coalesce(rq."reasons", '{}') AS "reasons"
	FROM "order_lines" l
	JOIN "orders" o ON o."id" = l."order_id"
	JOIN "stores" st ON st."id" = o."store_id"
	JOIN order_revenue rv ON rv."order_id" = o."id"
	LEFT JOIN received rc ON rc."order_line_id" = l."id"
	LEFT JOIN requested rq ON rq."order_line_id" = l."id"
	LEFT JOIN refunds rf ON rf."order_id" = o."id"
	-- Amazon's own (FBA) returns go back to Amazon and are never reported
	-- here, so its sales would only dilute the rate.
	WHERE l."product_id" IS NOT NULL AND l."quantity" > 0
		AND o."cancelled_at" IS NULL AND NOT o."fulfilled_by_channel"
)
SELECT
	"line_id", "order_id", "product_id", "sold_on", "placed_at", "sold",
	greatest("received", "requested", CASE WHEN "refunded_in_full" THEN "sold" ELSE 0 END)::int AS "returned",
	"received", "restocked", "requested", "refunded_in_full", "reasons"
FROM lines;
