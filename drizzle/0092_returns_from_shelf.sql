-- The Sumtracker cutover cleared every sale batch, and both views took "no
-- sale batch" to mean "never left our shelf", so Returns lost every order
-- shipped before it. order_line_costs (as in 0088) now says which lines left
-- the shelf, and order_returns_due (as in 0089) goes by that.
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
		-- Its units left our shelf: it took stock, or it shipped before the
		-- store's cutover (which wiped sale batches; the opening count has
		-- those units gone). Custom items without a product never did.
		(l."sale_batch_id" IS NOT NULL OR (l."product_id" IS NOT NULL AND EXISTS (
			SELECT 1 FROM "orders" o
			JOIN "stores" st ON st."id" = o."store_id"
			WHERE o."id" = l."order_id" AND o."placed_at" < st."stock_from"
		))) AS "from_shelf",
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
		l."from_shelf",
		-- Units off our shelf that haven't been received back yet.
		CASE WHEN rf."order_id" IS NOT NULL AND l."from_shelf"
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
	"returning",
	"from_shelf"
FROM costed;
--> statement-breakpoint
CREATE OR REPLACE VIEW "order_returns_due" AS
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
