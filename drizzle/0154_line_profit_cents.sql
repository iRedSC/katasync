-- order_line_profit as in 0090, but its lines add up to their order to the
-- cent. Each line rounding its own share of a charge could gain or lose a
-- cent: three $1 items sharing a $0.01 fee each paid nothing, yet the order
-- paid it. Now each charge is rounded along the order's lines by line id, a
-- line taking what the running total rounds to after it, less what it
-- rounded to before. Every line is within a cent of its share, and the last
-- leaves the order's total exactly. Costs, kept to a hundredth of a cent, are
-- rounded the same way, and profit is what the rounded parts leave.
CREATE OR REPLACE VIEW "order_line_profit" AS
WITH kept AS (
	SELECT
		lc.*,
		sum(lc."quantity") OVER (PARTITION BY lc."order_id") AS "order_units",
		count(*) OVER (PARTITION BY lc."order_id") AS "order_lines"
	FROM "order_line_costs" lc
	WHERE lc."quantity" > 0
		OR NOT EXISTS (
			SELECT 1 FROM "order_lines" l
			WHERE l."order_id" = lc."order_id" AND l."quantity" > 0
		)
),
weighted AS (
	SELECT
		k.*,
		CASE
			WHEN p."revenue" > 0 THEN k."revenue"
			WHEN k."order_units" > 0 THEN k."quantity"::numeric
			ELSE 1.0
		END AS "weight"
	FROM kept k
	JOIN "order_profit" p ON p."order_id" = k."order_id"
),
-- How far along its order each line is: by weight, for sharing charges, and
-- by cost.
running AS (
	SELECT
		w.*,
		sum(w."weight") OVER (PARTITION BY w."order_id" ORDER BY w."line_id") AS "upto",
		sum(w."weight") OVER (PARTITION BY w."order_id") AS "total",
		sum(coalesce(w."cost", 0)) OVER (PARTITION BY w."order_id" ORDER BY w."line_id") AS "cost_upto"
	FROM weighted w
),
shares AS (
	SELECT
		l.*,
		round(l."revenue", 2) AS "line_revenue",
		round(l."cost_upto", 2) - round(l."cost_upto" - coalesce(l."cost", 0), 2) AS "line_cost",
		round(p."fees" * l."upto" / l."total", 2)
			- round(p."fees" * (l."upto" - l."weight") / l."total", 2) AS "line_fees",
		round(p."labels" * l."upto" / l."total", 2)
			- round(p."labels" * (l."upto" - l."weight") / l."total", 2) AS "line_labels",
		round(p."shipping_charged" * l."upto" / l."total", 2)
			- round(p."shipping_charged" * (l."upto" - l."weight") / l."total", 2) AS "line_shipping",
		round(p."postage_adjustments" * l."upto" / l."total", 2)
			- round(p."postage_adjustments" * (l."upto" - l."weight") / l."total", 2) AS "line_postage",
		round(p."refunds" * l."upto" / l."total", 2)
			- round(p."refunds" * (l."upto" - l."weight") / l."total", 2) AS "line_refunds",
		round(p."adjustments" * l."upto" / l."total", 2)
			- round(p."adjustments" * (l."upto" - l."weight") / l."total", 2) AS "line_adjustments"
	FROM running l
	JOIN "order_profit" p ON p."order_id" = l."order_id"
)
SELECT
	l."line_id",
	l."order_id",
	l."product_id",
	p."sold_on",
	p."placed_at",
	l."quantity",
	-- Units a customer sent back to the shelf, which cost nothing.
	l."restocked"::int AS "restocked",
	l."line_revenue"::numeric(12, 2) AS "revenue",
	-- Unknown stays unknown; it adds nothing to the order's cost either.
	(CASE WHEN l."cost" IS NOT NULL THEN l."line_cost" END)::numeric(12, 2) AS "cost",
	l."cost_known",
	l."line_fees"::numeric(12, 2) AS "fees",
	l."line_labels"::numeric(12, 2) AS "labels",
	l."line_shipping"::numeric(12, 2) AS "shipping_charged",
	l."line_postage"::numeric(12, 2) AS "postage_adjustments",
	l."line_refunds"::numeric(12, 2) AS "refunds",
	l."line_adjustments"::numeric(12, 2) AS "adjustments",
	(l."line_revenue" + l."line_shipping" - l."line_cost" - l."line_fees"
		- l."line_labels" - l."line_postage" - l."line_refunds"
		- l."line_adjustments")::numeric(12, 2) AS "profit",
	p."fees_status",
	p."labels_status",
	(l."cost_known" AND p."fees_status" <> 'estimated'
		AND p."labels_status" IN ('known', 'not_needed')
		AND l."returning" = 0) AS "complete",
	p."shipped",
	-- Units refunded and expected back, whose cost isn't counted yet.
	l."returning"::int AS "returning",
	-- The whole order's, so a line whose share rounds to nothing still says
	-- its order was re-billed.
	p."postage_adjustments" AS "order_postage_adjustments"
FROM shares l
JOIN "order_profit" p ON p."order_id" = l."order_id";
