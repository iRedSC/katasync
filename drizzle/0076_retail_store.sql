ALTER TYPE "public"."location_kind" ADD VALUE 'retail';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sold_in_store" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Shopify POS orders synced before this were rung up at the store too. Their
-- sales_channel is what Shopify named the channel.
UPDATE "orders" SET "sold_in_store" = true
WHERE "sales_channel" IN ('Point of Sale', 'pos')
	AND "store_id" IN (SELECT "id" FROM "stores" WHERE "channel" = 'shopify');
--> statement-breakpoint
-- The retail store's shelf is ours too. Written as "not Amazon's" because a
-- new enum value can't be used in the transaction that adds it.
CREATE OR REPLACE VIEW "owned_stock" AS
SELECT p."id" AS "product_id", p."sku", coalesce(sum(s."on_hand"), 0)::int AS "on_hand"
FROM "products" p
LEFT JOIN "stock_levels" s ON s."product_id" = p."id"
	AND s."location_id" IN (SELECT "id" FROM "locations" WHERE "kind" <> 'fba')
WHERE p."kind" <> 'bundle'
GROUP BY p."id", p."sku";
