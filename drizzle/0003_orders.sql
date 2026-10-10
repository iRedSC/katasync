CREATE TABLE "order_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"listing_external_id" text,
	"product_id" integer,
	"sku" text,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"unit_cost" numeric(12, 4),
	"sale_batch_id" uuid,
	CONSTRAINT "order_lines_order_external_id" UNIQUE("order_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"store_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"fulfillment_status" text NOT NULL,
	"financial_status" text,
	"customer_name" text,
	"ship_city" text,
	"ship_region" text,
	"ship_country" text,
	"total" numeric(12, 2) NOT NULL,
	"shipping_charged" numeric(12, 2) DEFAULT 0 NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_store_external_id" UNIQUE("store_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "stock_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "orders_synced_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_lines_product_idx" ON "order_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "orders_placed_at_idx" ON "orders" USING btree ("placed_at");