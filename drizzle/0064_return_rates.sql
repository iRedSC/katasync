-- How often each product comes back, so a product returned a lot because it
-- sells a lot can be told from one returned too often.
--
-- Returns were only received in katasync from 2026-10-14, so a received
-- return can't be the only evidence: a line counts as returned by the most
-- any of these says came back:
--   received   units received here (order_returns)
--   requested  units a buyer's return request names, unless it was cancelled
--   refunded   every unit, when the order was refunded in full (the buyer
--              sent it back or kept it; either way it didn't stick)
-- A partial refund with neither of the others isn't counted: it may only
-- have been a price concession.
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
-- One row per product sold in the year that ended 45 days ago, so every
-- order counted has had time to come back (Amazon allows 30 days, plus the
-- trip). A tool set counts as itself, not its parts: it's what the buyer
-- sent back.
--
--   shop_rate  every product's returns over every product's sales
--   expected   returns this product's sales would bring at shop_rate
--   rate_low   the lowest rate its numbers make likely (Wilson, 95%), so
--              1 of 2 returned doesn't outrank 20 of 400
-- Returned too often: rate_low above shop_rate. Returned a lot only because
-- it sells a lot: returned near expected.
CREATE VIEW "product_return_rates" AS
WITH totals AS (
	SELECT "product_id", sum("sold")::int AS "sold", sum("returned")::int AS "returned",
		sum("received")::int AS "received", sum("restocked")::int AS "restocked",
		count(*) FILTER (WHERE "returned" > 0)::int AS "lines_returned"
	FROM "order_line_returns"
	WHERE "placed_at" >= now() - interval '410 days' AND "placed_at" < now() - interval '45 days'
	GROUP BY "product_id"
),
rated AS (
	SELECT t.*,
		t."returned"::numeric / t."sold" AS "rate",
		sum(t."returned") OVER ()::numeric / nullif(sum(t."sold") OVER (), 0) AS "shop_rate"
	FROM totals t
)
SELECT
	r."product_id", p."sku", r."sold", r."returned", r."received", r."restocked", r."lines_returned",
	round(r."rate", 4) AS "rate",
	round(greatest(0, (r."rate" + 1.9208 / r."sold"
		- 1.96 * sqrt(r."rate" * (1 - r."rate") / r."sold" + 0.9604 / (r."sold"::numeric * r."sold")))
		/ (1 + 3.8416 / r."sold")), 4) AS "rate_low",
	round(r."shop_rate", 4) AS "shop_rate",
	round(r."sold" * r."shop_rate", 1) AS "expected"
FROM rated r
JOIN "products" p ON p."id" = r."product_id";
--> statement-breakpoint
GRANT SELECT ON "order_line_returns", "product_return_rates" TO katasync_mcp;
