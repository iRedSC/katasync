ALTER TABLE "order_returns" ADD COLUMN "pre_cutover" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_pre_cutover_alone" CHECK (not ("order_returns"."pre_cutover" and ("order_returns"."restocked" or "order_returns"."refurb_product_id" is not null)));--> statement-breakpoint
-- order_line_costs as in 0083, but a unit that came back before cutover
-- costs the order nothing either: the stock count at cutover has it.
CREATE OR REPLACE VIEW "order_line_costs" AS
WITH bundle_costs AS (
	-- A tool set costs its parts, unknown if any part is.
	SELECT pc."parent_product_id" AS "product_id",
		CASE WHEN bool_and(cp."unit_cost" IS NOT NULL)
			THEN sum(cp."unit_cost" * pc."quantity") END AS "unit_cost"
	FROM "product_components" pc
	JOIN "products" cp ON cp."id" = pc."component_product_id"
	GROUP BY pc."parent_product_id"
),
returns AS (
	SELECT "order_line_id",
		sum("quantity") AS "returned",
		-- Refurbished units are back on a shelf too, as their refurb, which
		-- carries their cost to its own sale.
		sum("quantity") FILTER (WHERE "restocked" OR "refurb_product_id" IS NOT NULL
			OR "pre_cutover") AS "restocked"
	FROM "order_returns" GROUP BY "order_line_id"
),
order_revenue AS (
	SELECT "order_id", sum("unit_price" * "quantity") AS "revenue"
	FROM "order_lines" GROUP BY "order_id"
),
-- Shipped from our shelf lately and refunded everything it charged, items
-- and shipping, by the marketplace it really sold on (as order_profit counts
-- refunds). Refunded shipping can't pass for refunded items: a partial
-- refund keeps its cost.
refunded AS (
	SELECT o."id" AS "order_id"
	FROM "orders" o
	JOIN "stores" st ON st."id" = o."store_id"
	JOIN order_revenue rv ON rv."order_id" = o."id" AND rv."revenue" > 0
	JOIN "order_charges" ch ON ch."order_id" = o."id" AND ch."kind" = 'refund'
		AND ch."billed_by" = coalesce(split_part(o."marketplace_order_id", ':', 1)::"channel", st."channel")
	WHERE NOT o."fulfilled_by_channel" AND o."cancelled_at" IS NULL
		AND o."placed_at" >= now() - interval '60 days'
		AND o."no_return_at" IS NULL
	GROUP BY o."id", rv."revenue", o."shipping_charged"
	HAVING sum(ch."amount") >= rv."revenue" + o."shipping_charged"
),
lines AS (
	-- As in 0054: a line sold under a listing tagged "intangible" (labor, a
	-- catalog) has no stock or cost.
	SELECT l.*,
		l."product_id" IS NULL AND EXISTS (
			SELECT 1 FROM "orders" o
			JOIN "listings" li ON li."store_id" = o."store_id"
				AND li."external_id" = l."listing_external_id"
			WHERE o."id" = l."order_id"
				AND EXISTS (SELECT 1 FROM unnest(li."tags") t WHERE lower(t) = 'intangible')
		) AS "intangible"
	FROM "order_lines" l
),
costed AS (
	SELECT
		l."id" AS "line_id",
		l."order_id",
		l."product_id",
		l."quantity",
		l."unit_price" * l."quantity" AS "revenue",
		CASE WHEN l."intangible" THEN 0 ELSE coalesce(l."unit_cost",
			CASE WHEN pr."kind" = 'bundle' THEN bc."unit_cost" ELSE pr."unit_cost" END
		) END AS "unit_cost",
		coalesce(r."restocked", 0) AS "restocked",
		l."intangible",
		-- Units that took stock and haven't been received back yet.
		CASE WHEN rf."order_id" IS NOT NULL AND l."sale_batch_id" IS NOT NULL
			THEN l."quantity" - coalesce(r."returned", 0) ELSE 0 END AS "returning"
	FROM lines l
	LEFT JOIN "products" pr ON pr."id" = l."product_id"
	LEFT JOIN bundle_costs bc ON bc."product_id" = l."product_id"
	LEFT JOIN returns r ON r."order_line_id" = l."id"
	LEFT JOIN refunded rf ON rf."order_id" = l."order_id"
)
SELECT
	"line_id",
	"order_id",
	"product_id",
	"quantity",
	"revenue",
	"unit_cost",
	"restocked",
	-- Units returned to the shelf, or on their way back, aren't a cost.
	"unit_cost" * ("quantity" - "restocked" - "returning") AS "cost",
	-- A line cancelled down to nothing costs nothing either way.
	("quantity" = 0 OR "intangible" OR ("product_id" IS NOT NULL AND "unit_cost" IS NOT NULL)) AS "cost_known",
	"returning"
FROM costed;--> statement-breakpoint
-- Full refunds of orders shipped before cutover counted their items as lost:
-- past order_line_costs' 60 days, or within them without a sale batch to be
-- returning. Every one came back before katasync counted stock, so those
-- placed before 2026-10-11 (the last was placed 10-10) are received as
-- pre-cutover returns, dated when the order was placed since when they
-- arrived isn't known. Partial refunds are judged one by one below.
INSERT INTO "order_returns" ("order_line_id", "quantity", "restocked", "pre_cutover", "created_at")
SELECT l."id", l."quantity", false, true, o."placed_at"
FROM "orders" o
JOIN "stores" st ON st."id" = o."store_id"
JOIN "order_lines" l ON l."order_id" = o."id"
WHERE NOT o."fulfilled_by_channel" AND o."cancelled_at" IS NULL
	AND o."no_return_at" IS NULL
	AND o."placed_at" < '2026-10-11'
	AND l."quantity" > 0
	AND NOT EXISTS (
		SELECT 1 FROM "order_returns" r
		JOIN "order_lines" ol ON ol."id" = r."order_line_id"
		WHERE ol."order_id" = o."id"
	)
	AND (SELECT sum(ch."amount") FROM "order_charges" ch
		WHERE ch."order_id" = o."id" AND ch."kind" = 'refund'
			AND ch."billed_by" = coalesce(split_part(o."marketplace_order_id", ':', 1)::"channel", st."channel")
	) >= (SELECT sum(ol."unit_price" * ol."quantity") FROM "order_lines" ol
		WHERE ol."order_id" = o."id") + o."shipping_charged"
	AND (SELECT sum(ol."unit_price" * ol."quantity") FROM "order_lines" ol
		WHERE ol."order_id" = o."id") > 0;
--> statement-breakpoint
-- Partial refunds that came to exactly what some lines sold for: all the
-- items (keeping shipping) or the lines named, with a return opened for
-- most. Ones refunding a lost or late package, a swapped item, shipping
-- alone, or an amount matching no line keep their cost.
WITH back ("name", "unit_price") AS (VALUES
	('#4276', NULL::numeric), ('#2091', NULL), ('#2797', NULL), ('#2519', NULL),
	('#2875', NULL), ('#2738', NULL), ('#3356', NULL), ('#4423', NULL),
	('#3544', NULL), ('#3587', NULL), ('577524681491321531', NULL),
	('#2753', 79.00), ('577505111054455655', 35.98), ('#2801', 42.98),
	('#3816', 42.98), ('#3816', 16.98), ('#4827', 130.00), ('#4827', 6.27)
)
INSERT INTO "order_returns" ("order_line_id", "quantity", "restocked", "pre_cutover", "created_at")
SELECT l."id", l."quantity", false, true, o."placed_at"
FROM back b
JOIN "orders" o ON o."name" = b."name" AND NOT o."fulfilled_by_channel"
	AND o."cancelled_at" IS NULL AND o."placed_at" < '2026-08-23'
JOIN "order_lines" l ON l."order_id" = o."id" AND l."quantity" > 0
	AND (b."unit_price" IS NULL OR l."unit_price" = b."unit_price")
WHERE NOT EXISTS (
	SELECT 1 FROM "order_returns" r WHERE r."order_line_id" = l."id"
);
