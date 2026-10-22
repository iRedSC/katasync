-- Returns due since before cutover (2026-10-20) that came back before it,
-- as in 0086: received as pre-cutover returns, dated when the order was
-- placed, since the cutover count already has the units. A return asked for
-- more than two weeks before cutover had arrived by then. Partial refunds
-- matching whole lines came back too.
WITH back ("name", "sku", "quantity") AS (VALUES
	('#2977', NULL::text, NULL::int), ('#4503', NULL, NULL),
	('114-8333890-4540207', NULL, NULL), ('111-5319993-6641838', NULL, NULL),
	('112-9652122-9250653', NULL, NULL), ('#5013', NULL, NULL),
	('111-3744986-6348249', NULL, NULL), ('112-5134854-9617825', NULL, NULL),
	('114-6433445-8566635', NULL, NULL), ('112-7680750-4883461', NULL, NULL),
	('111-7516471-9720251', NULL, NULL), ('111-1676522-7117001', NULL, NULL),
	('111-4990622-0090629', NULL, NULL), ('#4690', NULL, NULL),
	('#5087', 'TT-JK05CSTT', 1), ('#5212', 'COL-FFBR-40-12', 1),
	('#5436', 'USG-340510', 1), ('#5436', 'USG-340006', 1)
)
INSERT INTO "order_returns" ("order_line_id", "quantity", "restocked", "pre_cutover", "created_at")
SELECT l."id", coalesce(b."quantity", d."expected"), false, true, o."placed_at"
FROM back b
JOIN "orders" o ON o."name" = b."name" AND o."placed_at" < '2026-10-20'
JOIN "order_returns_due" d ON d."order_id" = o."id"
JOIN "order_lines" l ON l."id" = d."line_id"
	AND (b."sku" IS NULL OR l."sku" = b."sku")
WHERE coalesce(b."quantity", d."expected") > 0;
--> statement-breakpoint
-- Nothing is coming back for these, so they leave Returns and keep their
-- cost: an Amazon return of a different item, a buyer who hasn't shipped in
-- four weeks, a shipping-only refund, and two refunds matching no lines.
UPDATE "orders" SET "no_return_at" = now()
WHERE "name" IN ('113-1860480-1484267', '#4840', '#5126', '#5291', '#5361')
	AND "placed_at" < '2026-10-20'
	AND "id" IN (SELECT "order_id" FROM "order_returns_due");
