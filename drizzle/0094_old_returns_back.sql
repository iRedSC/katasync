-- Returns starts over at cutover (2026-10-20). Nothing is coming back for
-- these, so they leave Returns and keep their cost: an Amazon return of a
-- different item, a buyer who hasn't shipped in four weeks, a shipping-only
-- refund, and two refunds matching no lines.
UPDATE "orders" SET "no_return_at" = now()
WHERE "name" IN ('113-1860480-1484267', '#4840', '#5126', '#5291', '#5361')
	AND "placed_at" < '2026-10-20'
	AND "id" IN (SELECT "order_id" FROM "order_returns_due");
--> statement-breakpoint
-- Every other return asked for on an order from before cutover came back
-- (nearly all do), and partial refunds matching whole lines did too. As in
-- 0086: received as pre-cutover returns, dated when the order was placed,
-- moving no stock: the cutover count has the units, and any that arrived
-- after it turn up at the next count.
WITH back ("name", "sku", "quantity") AS (VALUES
	('#5087', 'TT-JK05CSTT', 1), ('#5212', 'COL-FFBR-40-12', 1),
	('#5436', 'USG-340510', 1), ('#5436', 'USG-340006', 1)
)
INSERT INTO "order_returns" ("order_line_id", "quantity", "restocked", "pre_cutover", "created_at")
SELECT l."id", coalesce(b."quantity", d."expected"), false, true, o."placed_at"
FROM "order_returns_due" d
JOIN "orders" o ON o."id" = d."order_id" AND o."placed_at" < '2026-10-20'
JOIN "order_lines" l ON l."id" = d."line_id"
LEFT JOIN back b ON b."name" = o."name" AND b."sku" = l."sku"
WHERE (d."state" <> 'maybe' OR b."name" IS NOT NULL)
	AND coalesce(b."quantity", d."expected") > 0;
