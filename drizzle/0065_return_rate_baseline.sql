-- product_return_rates as in 0064, measured against where each product sold.
-- Channels report returns very differently (Amazon names every return;
-- Shopify only shows full refunds), so one shop-wide rate made Amazon-heavy
-- products look bad for selling on Amazon. And with a shop rate under 1%,
-- a single return of a single sale outranked 9 of 43.
--
--   baseline  the return rate its own sales would have at each channel's
--             rate: the bar it's held to
--   expected  returns that baseline brings
--   excess    returned minus expected: how many returns its sales don't
--             explain. Rank by this, among rows with rate_low above baseline.
DROP VIEW "product_return_rates";
--> statement-breakpoint
CREATE VIEW "product_return_rates" AS
WITH settled AS (
	SELECT * FROM "order_line_returns"
	WHERE "placed_at" >= now() - interval '410 days' AND "placed_at" < now() - interval '45 days'
),
channel_rates AS (
	SELECT "sold_on", sum("returned")::numeric / sum("sold") AS "rate"
	FROM settled GROUP BY "sold_on"
),
totals AS (
	SELECT s."product_id", sum(s."sold")::int AS "sold", sum(s."returned")::int AS "returned",
		sum(s."received")::int AS "received", sum(s."restocked")::int AS "restocked",
		count(*) FILTER (WHERE s."returned" > 0)::int AS "lines_returned",
		sum(s."sold" * c."rate") AS "expected"
	FROM settled s
	JOIN channel_rates c ON c."sold_on" = s."sold_on"
	GROUP BY s."product_id"
),
rated AS (
	SELECT t.*, t."returned"::numeric / t."sold" AS "rate"
	FROM totals t
)
SELECT
	r."product_id", p."sku", r."sold", r."returned", r."received", r."restocked", r."lines_returned",
	round(r."rate", 4) AS "rate",
	round(greatest(0, (r."rate" + 1.9208 / r."sold"
		- 1.96 * sqrt(r."rate" * (1 - r."rate") / r."sold" + 0.9604 / (r."sold"::numeric * r."sold")))
		/ (1 + 3.8416 / r."sold")), 4) AS "rate_low",
	round(r."expected" / r."sold", 4) AS "baseline",
	round(r."expected", 1) AS "expected",
	round(r."returned" - r."expected", 1) AS "excess"
FROM rated r
JOIN "products" p ON p."id" = r."product_id";
--> statement-breakpoint
GRANT SELECT ON "product_return_rates" TO katasync_mcp;
