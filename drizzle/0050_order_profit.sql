-- What each order made, one row per order that wasn't cancelled. Read by the
-- profit page and the MCP query tool alike, so both always agree.
--
--   profit = revenue + shipping charged - cost - fees - labels - refunds
--            - adjustments
--
-- revenue is what the lines sold for after discounts, without tax. cost is
-- the cost of goods when each line came in (a tool set's is its parts'),
-- less units a customer returned to the shelf. Fees, labels, refunds and
-- adjustments are what the marketplaces reported (order_charges), plus
-- labels bought in katasync (shipments).
--
-- Nothing unknown counts as $0. Each part says how sure it is:
--   fees_status   final: reported, and settled or too old to change
--                 reported: reported, may still change
--                 estimated: not reported yet, so fees are a typical rate
--                 of revenue for the marketplace
--   labels_status known: a label's cost is on file
--                 stand_in: only katasync's estimate for a TikTok label,
--                 until TikTok bills it
--                 not_needed: the marketplace shipped it (FBA), or it was
--                 picked up or sold in person
--                 not_shipped: no label yet because nothing has shipped
--                 missing: shipped, but no label cost from anyone
--   cost_known    every line has a product with a cost
-- complete is all three settled enough to trust the profit.
--
-- A label in katasync shared by several orders (one box for two orders to
-- the same address) is split by each order's revenue.
CREATE VIEW "order_profit" AS
WITH line_totals AS (
	SELECT
		l."order_id",
		sum(l."unit_price" * l."quantity") AS "revenue",
		sum(l."unit_cost" * (l."quantity" - coalesce(r."restocked", 0))) AS "cost",
		bool_and(l."product_id" IS NOT NULL AND l."unit_cost" IS NOT NULL) AS "cost_known"
	FROM "order_lines" l
	LEFT JOIN (
		SELECT "order_line_id", sum("quantity") AS "restocked"
		FROM "order_returns" WHERE "restocked" GROUP BY "order_line_id"
	) r ON r."order_line_id" = l."id"
	GROUP BY l."order_id"
),
charges AS (
	SELECT
		"order_id",
		sum("amount") FILTER (WHERE "kind" = 'fee') AS "fees",
		sum("amount") FILTER (WHERE "kind" = 'label') AS "labels",
		count(*) FILTER (WHERE "kind" = 'label') AS "label_lines",
		sum("amount") FILTER (WHERE "kind" = 'refund') AS "refunds",
		sum("amount") FILTER (WHERE "kind" = 'adjustment') AS "adjustments"
	FROM "order_charges" GROUP BY "order_id"
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
		bool_or("no_label") AS "no_label"
	FROM "order_cost_reports" GROUP BY "order_id"
),
base AS (
	SELECT
		o."id" AS "order_id",
		o."store_id",
		-- Where it was really sold: a relayed TikTok order is TikTok's.
		coalesce(split_part(o."marketplace_order_id", ':', 1)::"channel", st."channel") AS "sold_on",
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
		coalesce(r."no_label", false) AS "no_label"
	FROM "orders" o
	JOIN "stores" st ON st."id" = o."store_id"
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
		WHEN "label_lines" > 0 OR "bought" IS NOT NULL THEN 'known'
		WHEN "uses_stand_in" THEN 'stand_in'
		WHEN "fulfilled_by_channel" OR "no_label"
			OR "fulfillment_status" = 'FULFILLMENT_NOT_REQUIRED' THEN 'not_needed'
		WHEN "fulfillment_status" NOT IN ('FULFILLED', 'PARTIALLY_FULFILLED') THEN 'not_shipped'
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
		AND p."labels_status" IN ('known', 'not_needed')) AS "complete"
FROM parts p;
--> statement-breakpoint
GRANT SELECT ON "order_profit" TO katasync_mcp;
