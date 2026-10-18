-- Amazon's Pending orders aren't confirmed: no price yet, nothing shipped.
-- FBA ones were stored as needing no shipping; they wait for payment like
-- the rest, until Amazon confirms them and the next sync moves them on.
UPDATE "orders" o SET "fulfillment_status" = 'AWAITING_PAYMENT'
FROM "stores" s
WHERE s."id" = o."store_id" AND s."channel" = 'amazon'
	AND o."financial_status" = 'PENDING'
	AND o."fulfillment_status" = 'FULFILLMENT_NOT_REQUIRED'
	AND o."cancelled_at" IS NULL;
--> statement-breakpoint
-- order_profit and order_line_profit as in 0051, plus "shipped", and an
-- order waiting for payment counts as not shipped even when Amazon will
-- ship it.
CREATE OR REPLACE VIEW "order_profit" AS
WITH sold_on AS (
	-- Where it was really sold: a relayed TikTok order is TikTok's.
	SELECT o."id" AS "order_id",
		coalesce(split_part(o."marketplace_order_id", ':', 1)::"channel", st."channel") AS "sold_on"
	FROM "orders" o JOIN "stores" st ON st."id" = o."store_id"
),
line_totals AS (
	SELECT
		"order_id",
		sum("revenue") AS "revenue",
		sum("cost") AS "cost",
		bool_and("cost_known") AS "cost_known"
	FROM "order_line_costs"
	GROUP BY "order_id"
),
-- Refunds count only from the marketplace the order really sold on: a
-- relayed TikTok order's refund also shows up in Shopify, and is TikTok's.
charges AS (
	SELECT
		ch."order_id",
		sum(ch."amount") FILTER (WHERE ch."kind" = 'fee') AS "fees",
		sum(ch."amount") FILTER (WHERE ch."kind" = 'label') AS "labels",
		count(*) FILTER (WHERE ch."kind" = 'label') AS "label_lines",
		sum(ch."amount") FILTER (WHERE ch."kind" = 'refund' AND ch."billed_by" = so."sold_on") AS "refunds",
		sum(ch."amount") FILTER (WHERE ch."kind" = 'adjustment') AS "adjustments"
	FROM "order_charges" ch
	JOIN sold_on so ON so."order_id" = ch."order_id"
	GROUP BY ch."order_id"
),
-- Each live katasync label, with each of its dispatch's orders' share.
label_shares AS (
	SELECT
		d."order_id",
		s."provider",
		s."cost" * coalesce(
			lt."revenue" / nullif(sum(lt."revenue") OVER (PARTITION BY s."id"), 0),
			1.0 / count(*) OVER (PARTITION BY s."id")
		) AS "share"
	FROM "shipments" s
	JOIN "dispatches" dp ON dp."id" = s."dispatch_id" AND dp."bought_at" IS NOT NULL
	JOIN "dispatch_orders" d ON d."dispatch_id" = s."dispatch_id"
	-- A cancelled order sharing the box leaves its share to the others.
	JOIN "orders" o ON o."id" = d."order_id" AND o."cancelled_at" IS NULL
	LEFT JOIN line_totals lt ON lt."order_id" = d."order_id"
	WHERE s."voided_at" IS NULL AND NOT s."test"
),
katasync_labels AS (
	SELECT
		"order_id",
		sum("share") FILTER (WHERE "provider" <> 'tiktok') AS "bought",
		sum("share") FILTER (WHERE "provider" = 'tiktok') AS "tiktok"
	FROM label_shares GROUP BY "order_id"
),
reports AS (
	SELECT
		"order_id",
		array_agg("billed_by") AS "billers",
		array_agg("billed_by") FILTER (WHERE "settled") AS "settled_by",
		bool_or("no_label") AS "no_label",
		bool_or("labels_pending") AS "labels_pending"
	FROM "order_cost_reports" GROUP BY "order_id"
),
base AS (
	SELECT
		o."id" AS "order_id",
		o."store_id",
		so."sold_on",
		o."placed_at",
		o."fulfillment_status",
		o."fulfilled_by_channel",
		coalesce(lt."revenue", 0) AS "revenue",
		o."shipping_charged",
		coalesce(lt."cost", 0) AS "cost",
		coalesce(lt."cost_known", false) AS "cost_known",
		c."fees",
		coalesce(c."labels", 0) AS "reported_labels",
		coalesce(c."label_lines", 0) AS "label_lines",
		coalesce(c."refunds", 0) AS "refunds",
		coalesce(c."adjustments", 0) AS "adjustments",
		kl."bought",
		kl."tiktok",
		r."billers",
		r."settled_by",
		coalesce(r."no_label", false) AS "no_label",
		coalesce(r."labels_pending", false) AS "labels_pending"
	FROM "orders" o
	JOIN sold_on so ON so."order_id" = o."id"
	LEFT JOIN line_totals lt ON lt."order_id" = o."id"
	LEFT JOIN charges c ON c."order_id" = o."id"
	LEFT JOIN katasync_labels kl ON kl."order_id" = o."id"
	LEFT JOIN reports r ON r."order_id" = o."id"
	WHERE o."cancelled_at" IS NULL
),
judged AS (
	SELECT
		b.*,
		CASE
			WHEN NOT (b."sold_on" = ANY (coalesce(b."billers", '{}'))) THEN 'estimated'
			WHEN b."sold_on" = ANY (coalesce(b."settled_by", '{}'))
				OR b."placed_at" < now() - interval '60 days' THEN 'final'
			ELSE 'reported'
		END AS "fees_status",
		-- TikTok's stand-in counts only until TikTok has reported.
		(b."tiktok" IS NOT NULL AND NOT ('tiktok' = ANY (coalesce(b."billers", '{}')))) AS "uses_stand_in"
	FROM base b
),
parts AS (
SELECT
	"order_id",
	"store_id",
	"sold_on",
	"placed_at",
	round("revenue", 2)::numeric(12, 2) AS "revenue",
	"shipping_charged",
	round("cost", 2)::numeric(12, 2) AS "cost",
	"cost_known",
	round(CASE "fees_status"
		WHEN 'estimated' THEN CASE "sold_on"
			WHEN 'amazon' THEN "revenue" * 0.15
			WHEN 'ebay' THEN "revenue" * 0.1325
			WHEN 'tiktok' THEN "revenue" * 0.06
			ELSE "revenue" * 0.029 + 0.30
		END
		ELSE coalesce("fees", 0)
	END, 2)::numeric(12, 2) AS "fees",
	"fees_status",
	round("reported_labels" + coalesce("bought", 0)
		+ CASE WHEN "uses_stand_in" THEN "tiktok" ELSE 0 END, 2)::numeric(12, 2) AS "labels",
	CASE
		-- Not confirmed yet (Amazon's Pending), so nothing has shipped, FBA
		-- or not.
		WHEN "fulfillment_status" = 'AWAITING_PAYMENT' THEN 'not_shipped'
		WHEN "labels_pending" OR ("uses_stand_in" AND "label_lines" = 0 AND "bought" IS NULL) THEN 'stand_in'
		WHEN "label_lines" > 0 OR "bought" IS NOT NULL THEN 'known'
		WHEN "fulfilled_by_channel" OR "no_label"
			OR "fulfillment_status" = 'FULFILLMENT_NOT_REQUIRED' THEN 'not_needed'
		WHEN "fulfillment_status" NOT IN ('FULFILLED', 'PARTIALLY_FULFILLED') THEN 'not_shipped'
		WHEN "fees_status" = 'estimated' THEN 'awaiting'
		ELSE 'missing'
	END AS "labels_status",
	"refunds",
	"adjustments"
FROM judged
)
SELECT
	p.*,
	(p."revenue" + p."shipping_charged" - p."cost" - p."fees" - p."labels"
		- p."refunds" - p."adjustments")::numeric(12, 2) AS "profit",
	(p."cost_known" AND p."fees_status" <> 'estimated'
		AND p."labels_status" IN ('known', 'not_needed')) AS "complete",
	-- Confirmed and on its way (or needing no shipping): what the Profit tab
	-- counts. An unshipped order's label and fees are still to come.
	(p."labels_status" <> 'not_shipped') AS "shipped"
FROM parts p;
--> statement-breakpoint
-- What each item sold made: one row per order line with units, its sales
-- less its cost, less its share of the order's fees, labels, refunds and
-- adjustments, net of the shipping the buyer paid. Shares go by sales, or by
-- units on a free order (a replacement). An order whose every line was
-- cancelled down to nothing keeps its lines, sharing what it still cost
-- evenly, so its lines always add up to its profit in order_profit, give or
-- take rounding.
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
lines AS (
	SELECT
		k.*,
		CASE
			WHEN p."revenue" > 0 THEN k."revenue" / p."revenue"
			WHEN k."order_units" > 0 THEN k."quantity"::numeric / k."order_units"
			ELSE 1.0 / k."order_lines"
		END AS "share"
	FROM kept k
	JOIN "order_profit" p ON p."order_id" = k."order_id"
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
	round(l."revenue", 2)::numeric(12, 2) AS "revenue",
	round(l."cost", 2)::numeric(12, 2) AS "cost",
	l."cost_known",
	round(l."share" * p."fees", 2)::numeric(12, 2) AS "fees",
	round(l."share" * p."labels", 2)::numeric(12, 2) AS "labels",
	round(l."share" * p."shipping_charged", 2)::numeric(12, 2) AS "shipping_charged",
	round(l."share" * p."refunds", 2)::numeric(12, 2) AS "refunds",
	round(l."share" * p."adjustments", 2)::numeric(12, 2) AS "adjustments",
	round(l."revenue" - coalesce(l."cost", 0) + l."share" * (p."shipping_charged"
		- p."fees" - p."labels" - p."refunds" - p."adjustments"), 2)::numeric(12, 2) AS "profit",
	p."fees_status",
	p."labels_status",
	(l."cost_known" AND p."fees_status" <> 'estimated'
		AND p."labels_status" IN ('known', 'not_needed')) AS "complete",
	p."shipped"
FROM lines l
JOIN "order_profit" p ON p."order_id" = l."order_id";
