CREATE TYPE "public"."channel" AS ENUM('shopify', 'amazon', 'ebay', 'tiktok');--> statement-breakpoint
CREATE TYPE "public"."listing_fulfillment" AS ENUM('merchant', 'fba');--> statement-breakpoint
CREATE TYPE "public"."location_kind" AS ENUM('owned', 'fba');--> statement-breakpoint
CREATE TYPE "public"."movement_reason" AS ENUM('receipt', 'sale', 'return', 'adjustment', 'transfer_out', 'transfer_in', 'assembly_consume', 'assembly_produce');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('simple', 'kit', 'bundle');--> statement-breakpoint
CREATE TABLE "listings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "listings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"store_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"external_sku" text,
	"title" text NOT NULL,
	"fulfillment" "listing_fulfillment" DEFAULT 'merchant' NOT NULL,
	"product_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_store_external_id" UNIQUE("store_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "locations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"kind" "location_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"batch_id" uuid NOT NULL,
	"product_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"delta" integer NOT NULL,
	"reason" "movement_reason" NOT NULL,
	"reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movements_delta_nonzero" CHECK ("movements"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "product_components" (
	"parent_product_id" integer NOT NULL,
	"component_product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "product_components_parent_product_id_component_product_id_pk" PRIMARY KEY("parent_product_id","component_product_id"),
	CONSTRAINT "product_components_quantity_positive" CHECK ("product_components"."quantity" > 0),
	CONSTRAINT "product_components_not_self" CHECK ("product_components"."parent_product_id" <> "product_components"."component_product_id")
);
--> statement-breakpoint
CREATE TABLE "product_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"kind" "product_kind" NOT NULL,
	"group_id" integer,
	"variant_name" text,
	"image_url" text,
	"barcode" text,
	"unit_cost" numeric(12, 4),
	"weight_grams" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku"),
	CONSTRAINT "products_barcode_unique" UNIQUE("barcode"),
	CONSTRAINT "products_variant_needs_group" CHECK ("products"."variant_name" is null or "products"."group_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"product_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stock_levels_product_id_location_id_pk" PRIMARY KEY("product_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stores_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel" "channel" NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_parent_product_id_products_id_fk" FOREIGN KEY ("parent_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_component_product_id_products_id_fk" FOREIGN KEY ("component_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_group_id_product_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."product_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_product_idx" ON "listings" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "movements_product_location_idx" ON "movements" USING btree ("product_id","location_id");--> statement-breakpoint
CREATE INDEX "movements_created_at_idx" ON "movements" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "products_group_idx" ON "products" USING btree ("group_id");