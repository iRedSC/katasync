CREATE TABLE "purchase_units" (
	"name" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- EACH must exist before the default refers to it. The rest are a starting list.
INSERT INTO "purchase_units" ("name") VALUES ('EACH'), ('PACK'), ('BOX'), ('CASE');--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "unit" text DEFAULT 'EACH' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "pack_size" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "unit" text DEFAULT 'EACH' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "pack_size" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_unit_purchase_units_name_fk" FOREIGN KEY ("unit") REFERENCES "public"."purchase_units"("name") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_pack_size_positive" CHECK ("product_suppliers"."pack_size" > 0);--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_each_is_one" CHECK ("product_suppliers"."unit" <> 'EACH' or "product_suppliers"."pack_size" = 1);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_pack_size_positive" CHECK ("purchase_order_lines"."pack_size" > 0);