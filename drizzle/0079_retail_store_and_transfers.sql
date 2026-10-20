CREATE TYPE "public"."transfer_status" AS ENUM('draft', 'sent');--> statement-breakpoint
ALTER TYPE "public"."location_kind" ADD VALUE 'retail';--> statement-breakpoint
CREATE TABLE "shelf_targets" (
	"product_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"target" integer NOT NULL,
	CONSTRAINT "shelf_targets_product_id_location_id_pk" PRIMARY KEY("product_id","location_id"),
	CONSTRAINT "shelf_targets_positive" CHECK ("shelf_targets"."target" > 0)
);
--> statement-breakpoint
CREATE TABLE "transfer_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfer_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"transfer_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "transfer_lines_one_per_product" UNIQUE("transfer_id","product_id"),
	CONSTRAINT "transfer_lines_quantity" CHECK ("transfer_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"from_location_id" integer NOT NULL,
	"to_location_id" integer NOT NULL,
	"status" "transfer_status" DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"batch_id" uuid,
	CONSTRAINT "transfers_batchId_unique" UNIQUE("batch_id"),
	CONSTRAINT "transfers_two_places" CHECK ("transfers"."from_location_id" <> "transfers"."to_location_id"),
	CONSTRAINT "transfers_sent_moved" CHECK (("transfers"."status" = 'sent') = ("transfers"."batch_id" is not null and "transfers"."sent_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sold_in_store" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "retail_reserve" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelf_targets" ADD CONSTRAINT "shelf_targets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_targets" ADD CONSTRAINT "shelf_targets_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfers_status_idx" ON "transfers" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_retail_reserve" CHECK ("settings"."retail_reserve" >= 0);--> statement-breakpoint
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
--> statement-breakpoint
-- The query tool can read transfers and targets (see drizzle/0027_mcp_role.sql).
GRANT SELECT ON "transfers", "transfer_lines", "shelf_targets" TO katasync_mcp;
