-- A Shopify listing tagged "intangible" sells something with no stock or
-- cost, like labor or a catalog. Its lines cost nothing, and their cost is
-- known, so the order's profit is complete. Matching it to a product later
-- uses that product's cost instead.
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
lines AS (
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
		l."intangible"
	FROM lines l
	LEFT JOIN "products" pr ON pr."id" = l."product_id"
	LEFT JOIN bundle_costs bc ON bc."product_id" = l."product_id"
	LEFT JOIN (
		SELECT "order_line_id", sum("quantity") AS "restocked"
		FROM "order_returns" WHERE "restocked" GROUP BY "order_line_id"
	) r ON r."order_line_id" = l."id"
)
SELECT
	"line_id",
	"order_id",
	"product_id",
	"quantity",
	"revenue",
	"unit_cost",
	"restocked",
	-- Units returned to the shelf aren't a cost.
	"unit_cost" * ("quantity" - "restocked") AS "cost",
	-- A line cancelled down to nothing costs nothing either way.
	("quantity" = 0 OR "intangible" OR ("product_id" IS NOT NULL AND "unit_cost" IS NOT NULL)) AS "cost_known"
FROM costed;
