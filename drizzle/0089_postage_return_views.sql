-- The returns views 0088 dropped to change charge_kind, back exactly as they
-- were: order_returns_due as in 0082, order_line_returns as in 0065,
-- product_return_rates as in 0067. Pending migrations run in one
-- transaction, so they're never missing in between.
CREATE VIEW "order_returns_due" AS
WITH received AS (
	SELECT "order_line_id", sum("quantity") AS "returned"
	FROM "order_returns" GROUP BY "order_line_id"
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
		l."quantity" - coalesce(rc."returned", 0) AS "left",
		greatest(least(coalesce(rq."quantity", 0), l."quantity") - coalesce(rc."returned", 0), 0) AS "requested",
		coalesce(rq."sent", false) AS "sent",
		um."order_id" IS NOT NULL AS "unmatched",
		coalesce(um."sent", false) AS "unmatched_sent",
		lc."returning",
		coalesce(rc."returned", 0) AS "returned",
		o."no_return_at",
		o."placed_at",
		coalesce(rf."amount", 0) AS "refunds"
	FROM "order_lines" l
	JOIN "orders" o ON o."id" = l."order_id"
	JOIN "order_line_costs" lc ON lc."line_id" = l."id"
	LEFT JOIN received rc ON rc."order_line_id" = l."id"
	LEFT JOIN requested rq ON rq."order_line_id" = l."id"
	LEFT JOIN unmatched um ON um."order_id" = l."order_id"
	LEFT JOIN refunds rf ON rf."order_id" = l."order_id"
	WHERE l."sale_batch_id" IS NOT NULL
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
--> statement-breakpoint
CREATE VIEW "order_line_returns" AS
WITH received AS (
	SELECT "order_line_id",
		sum("quantity") AS "received",
		sum("quantity") FILTER (WHERE "restocked") AS "restocked"
	FROM "order_returns" GROUP BY "order_line_id"
),
requested AS (
	SELECT rl."order_line_id",
		sum(rl."quantity") AS "requested",
		array_agg(DISTINCT rr."reason") FILTER (WHERE rr."reason" IS NOT NULL) AS "reasons"
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
--> statement-breakpoint
CREATE VIEW "product_return_rates" AS
WITH settled AS (
	-- One row per product per order: an order can sell it on two lines.
	SELECT "product_id", "order_id", "sold_on",
		sum("sold")::int AS "sold", sum("returned")::int AS "returned",
		sum("received")::int AS "received", sum("restocked")::int AS "restocked"
	FROM "order_line_returns"
	WHERE "placed_at" >= now() - interval '410 days' AND "placed_at" < now() - interval '45 days'
	GROUP BY "product_id", "order_id", "sold_on"
),
channel_rates AS (
	SELECT "sold_on", count(*) FILTER (WHERE "returned" > 0)::numeric / count(*) AS "rate"
	FROM settled GROUP BY "sold_on"
),
totals AS (
	SELECT s."product_id",
		count(*)::int AS "orders",
		count(*) FILTER (WHERE s."returned" > 0)::int AS "orders_returned",
		sum(s."sold")::int AS "sold", sum(s."returned")::int AS "returned",
		sum(s."received")::int AS "received", sum(s."restocked")::int AS "restocked",
		sum(c."rate") AS "expected"
	FROM settled s
	JOIN channel_rates c ON c."sold_on" = s."sold_on"
	GROUP BY s."product_id"
),
rated AS (
	SELECT t.*, t."orders_returned"::numeric / t."orders" AS "rate"
	FROM totals t
)
SELECT
	r."product_id", p."sku", r."orders", r."orders_returned",
	r."sold", r."returned", r."received", r."restocked",
	round(r."rate", 4) AS "rate",
	round(greatest(0, (r."rate" + 1.9208 / r."orders"
		- 1.96 * sqrt(r."rate" * (1 - r."rate") / r."orders" + 0.9604 / (r."orders"::numeric * r."orders")))
		/ (1 + 3.8416 / r."orders")), 4) AS "rate_low",
	round(r."expected" / r."orders", 4) AS "baseline",
	round(r."expected", 1) AS "expected",
	round(r."orders_returned" - r."expected", 1) AS "excess"
FROM rated r
JOIN "products" p ON p."id" = r."product_id";
--> statement-breakpoint
-- Dropping the views took their grants with them.
GRANT SELECT ON "order_returns_due", "order_line_returns", "product_return_rates" TO katasync_mcp;
