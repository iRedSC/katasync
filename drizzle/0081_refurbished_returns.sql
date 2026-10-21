ALTER TABLE "order_returns" DROP CONSTRAINT "order_returns_restocked_has_batch";--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "refurb_product_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "refurbished_from_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "condition" text;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_refurb_product_id_products_id_fk" FOREIGN KEY ("refurb_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_refurbished_from_id_products_id_fk" FOREIGN KEY ("refurbished_from_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_one_shelf" CHECK (not ("order_returns"."restocked" and "order_returns"."refurb_product_id" is not null));--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_restocked_has_batch" CHECK (("order_returns"."restocked" or "order_returns"."refurb_product_id" is not null) = ("order_returns"."batch_id" is not null));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_refurb_has_condition" CHECK (("products"."refurbished_from_id" is null) = ("products"."condition" is null));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_refurb_is_simple" CHECK ("products"."refurbished_from_id" is null or "products"."kind" = 'simple');--> statement-breakpoint
-- order_line_costs as in 0061, but a unit refurbished from a return costs
-- the order nothing, as a restocked one doesn't: its cost goes with it to
-- the refurb product and is counted when that sells.
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
		sum("quantity") FILTER (WHERE "restocked" OR "refurb_product_id" IS NOT NULL) AS "restocked"
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
FROM costed;
