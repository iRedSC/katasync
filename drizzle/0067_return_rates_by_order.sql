-- product_return_rates as in 0065, counted by order instead of by unit. A
-- buyer decides once however many are in the box, so 3 units sent back on
-- one order are one return. By unit, products bought in multiples looked
-- worse than ones bought singly, and rate_low treated each unit as a
-- separate decision, so it was surer than the orders allowed.
--
--   orders           orders that had this product
--   orders_returned  of those, ones that sent any of it back
--   rate, rate_low   orders_returned over orders
--   baseline         that rate at each channel's own order rate
--   expected, excess in orders
-- sold, returned, received and restocked stay in units, for cost and stock.
DROP VIEW "product_return_rates";
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
GRANT SELECT ON "product_return_rates" TO katasync_mcp;
