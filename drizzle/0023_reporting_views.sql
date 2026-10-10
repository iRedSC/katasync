-- Views that carry katasync's counting rules, so ad hoc questions (the MCP
-- query tool) and reorder suggestions count the same way.

-- Stock on our own shelves per product. Amazon's FBA stock is left out: it's
-- Amazon's to ship, not ours. Negative means oversold.
CREATE VIEW "owned_stock" AS
SELECT p."id" AS "product_id", p."sku", coalesce(sum(s."on_hand"), 0)::int AS "on_hand"
FROM "products" p
LEFT JOIN "stock_levels" s ON s."product_id" = p."id"
	AND s."location_id" IN (SELECT "id" FROM "locations" WHERE "kind" = 'owned')
WHERE p."kind" <> 'bundle'
GROUP BY p."id", p."sku";
--> statement-breakpoint
-- Units of stocked products that left our shelves, one row per order line
-- (twice for a tool set line: once per part). Tool sets count as their parts,
-- since that's what's picked. Cancelled orders and ones Amazon ships from its
-- own stock (FBA) are left out. Lines not yet matched to a product aren't here.
CREATE VIEW "sales_units" AS
SELECT
	coalesce(c."component_product_id", l."product_id") AS "product_id",
	o."id" AS "order_id",
	o."store_id",
	o."placed_at",
	(l."quantity" * coalesce(c."quantity", 1))::int AS "units"
FROM "order_lines" l
JOIN "orders" o ON o."id" = l."order_id"
JOIN "products" p ON p."id" = l."product_id"
LEFT JOIN "product_components" c ON c."parent_product_id" = l."product_id" AND p."kind" = 'bundle'
WHERE o."cancelled_at" IS NULL AND NOT o."fulfilled_by_channel";
