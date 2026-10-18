CREATE TYPE "public"."return_request_status" AS ENUM('requested', 'shipped', 'delivered', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "return_request_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "return_request_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"request_id" integer NOT NULL,
	"order_line_id" integer,
	"sku" text,
	"quantity" integer NOT NULL,
	CONSTRAINT "return_request_lines_quantity_positive" CHECK ("return_request_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "return_requests" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "return_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"billed_by" "channel" NOT NULL,
	"external_id" text NOT NULL,
	"status" "return_request_status" NOT NULL,
	"raw_status" text NOT NULL,
	"reason" text,
	"tracking_number" text,
	"carrier" text,
	"requested_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_requests_billed_by_external_id" UNIQUE("billed_by","external_id")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "no_return_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "return_request_lines" ADD CONSTRAINT "return_request_lines_request_id_return_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request_lines" ADD CONSTRAINT "return_request_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "return_request_lines_request_idx" ON "return_request_lines" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "return_requests_order_idx" ON "return_requests" USING btree ("order_id");
--> statement-breakpoint
-- order_line_costs as in 0054, except "Nothing coming back" ends the wait:
-- a refunded order marked so counts its cost at once.
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
		sum("quantity") FILTER (WHERE "restocked") AS "restocked"
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
costed AS (
	SELECT
		l."id" AS "line_id",
		l."order_id",
		l."product_id",
		l."quantity",
		l."unit_price" * l."quantity" AS "revenue",
		coalesce(l."unit_cost",
			CASE WHEN pr."kind" = 'bundle' THEN bc."unit_cost" ELSE pr."unit_cost" END
		) AS "unit_cost",
		coalesce(r."restocked", 0) AS "restocked",
		-- Units that took stock and haven't been received back yet.
		CASE WHEN rf."order_id" IS NOT NULL AND l."sale_batch_id" IS NOT NULL
			THEN l."quantity" - coalesce(r."returned", 0) ELSE 0 END AS "returning"
	FROM "order_lines" l
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
	("quantity" = 0 OR ("product_id" IS NOT NULL AND "unit_cost" IS NOT NULL)) AS "cost_known",
	"returning"
FROM costed;
--> statement-breakpoint
-- What's due back on each order, one row per line expected, so the Returns
-- tab, the order page and search read one rule. Only lines that took stock
-- count: anything sold before the ledger began (or never matched) would
-- double its stock if put back. Each order is in one state:
--   on_its_way  an open request the buyer shipped (or has tracking)
--   requested   an open request not shipped yet
--   refunded    refunded in full, presumed coming back (order_line_costs)
--   maybe       refunded in part, nothing received, no request
-- "Nothing coming back" (orders.no_return_at) ends all four, except a
-- request opened after it. Units received here come off what's expected.
CREATE VIEW "order_returns_due" AS
WITH received AS (
	SELECT "order_line_id", sum("quantity") AS "returned"
	FROM "order_returns" GROUP BY "order_line_id"
),
open_requests AS (
	SELECT rr."id", rr."status", rr."tracking_number"
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
	LEFT JOIN refunds rf ON rf."order_id" = l."order_id"
	WHERE l."sale_batch_id" IS NOT NULL
		AND NOT o."fulfilled_by_channel" AND o."cancelled_at" IS NULL
),
states AS (
	SELECT "order_id",
		CASE
			WHEN bool_or("requested" > 0 AND "sent") THEN 'on_its_way'
			WHEN bool_or("requested" > 0) THEN 'requested'
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
	AND (CASE s."state"
		WHEN 'maybe' THEN l."left"
		ELSE greatest(l."requested", l."returning")
	END) > 0;
