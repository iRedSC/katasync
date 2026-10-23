CREATE TABLE "catalogs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalogs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogs_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_excluded_catalogs" (
	"purchase_order_id" integer NOT NULL,
	"catalog_id" integer NOT NULL,
	CONSTRAINT "purchase_order_excluded_catalogs_purchase_order_id_catalog_id_pk" PRIMARY KEY("purchase_order_id","catalog_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_catalogs" (
	"supplier_id" integer NOT NULL,
	"catalog_id" integer NOT NULL,
	CONSTRAINT "supplier_catalogs_supplier_id_catalog_id_pk" PRIMARY KEY("supplier_id","catalog_id")
);
--> statement-breakpoint
-- A product can now be bought from every supplier carrying its catalog.
ALTER TABLE "product_suppliers" DROP CONSTRAINT "product_suppliers_pkey";--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_product_id_supplier_id_pk" PRIMARY KEY("product_id","supplier_id");--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "catalog_id" integer;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "cover_days" integer;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "include_pricier" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_excluded_catalogs" ADD CONSTRAINT "purchase_order_excluded_catalogs_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_excluded_catalogs" ADD CONSTRAINT "purchase_order_excluded_catalogs_catalog_id_catalogs_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."catalogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_catalogs" ADD CONSTRAINT "supplier_catalogs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_catalogs" ADD CONSTRAINT "supplier_catalogs_catalog_id_catalogs_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."catalogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_catalogs_catalog_idx" ON "supplier_catalogs" USING btree ("catalog_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_catalog_id_catalogs_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."catalogs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_catalog_idx" ON "products" USING btree ("catalog_id");--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cover_days_range" CHECK ("purchase_orders"."cover_days" between 1 and 365);--> statement-breakpoint
-- Each supplier starts with a catalog of what it sells today, named after
-- it, so reorder buys everything where it did before. Supplier names aren't
-- unique, so a shared one gets the supplier's (unique) code added, and each
-- supplier finds its catalog by that name.
CREATE TEMPORARY TABLE "catalog_backfill" AS
SELECT s."id" AS "supplier_id", CASE WHEN count(*) OVER (PARTITION BY s."name") > 1
		THEN s."name" || ' (' || s."code" || ')' ELSE s."name" END AS "catalog_name"
FROM "suppliers" s
WHERE EXISTS (SELECT 1 FROM "product_suppliers" ps WHERE ps."supplier_id" = s."id");--> statement-breakpoint
INSERT INTO "catalogs" ("name") SELECT "catalog_name" FROM "catalog_backfill";--> statement-breakpoint
INSERT INTO "supplier_catalogs" ("supplier_id", "catalog_id")
SELECT b."supplier_id", c."id"
FROM "catalog_backfill" b JOIN "catalogs" c ON c."name" = b."catalog_name";--> statement-breakpoint
UPDATE "products" p SET "catalog_id" = c."id"
FROM "product_suppliers" ps
JOIN "catalog_backfill" b ON b."supplier_id" = ps."supplier_id"
JOIN "catalogs" c ON c."name" = b."catalog_name"
WHERE ps."product_id" = p."id";--> statement-breakpoint
DROP TABLE "catalog_backfill";--> statement-breakpoint
-- What each supplier sells (schema.ts supplierOffers): every stocked product
-- in a catalog it carries, on its terms or the defaults, and which supplier
-- reorder buys each from.
CREATE VIEW "supplier_offers" AS
WITH offers AS (
	SELECT
		p."id" AS "product_id",
		sc."supplier_id",
		p."catalog_id",
		ps."supplier_sku",
		coalesce(ps."unit", 'EACH') AS "unit",
		coalesce(ps."pack_size", 1) AS "pack_size",
		coalesce(ps."supplier_count", 1) AS "supplier_count",
		ps."cost",
		coalesce(ps."minimum_quantity", 1) AS "minimum_quantity",
		ps."cost" / coalesce(ps."pack_size", 1) AS "item_cost",
		s."lead_time_days",
		s."name" AS "supplier_name"
	FROM "products" p
	JOIN "supplier_catalogs" sc ON sc."catalog_id" = p."catalog_id"
	JOIN "suppliers" s ON s."id" = sc."supplier_id"
	LEFT JOIN "product_suppliers" ps
		ON ps."product_id" = p."id" AND ps."supplier_id" = sc."supplier_id"
	-- A tool set is bought as its parts.
	WHERE p."kind" <> 'bundle'
)
SELECT
	"product_id", "supplier_id", "catalog_id", "supplier_sku", "unit",
	"pack_size", "supplier_count", "cost", "minimum_quantity", "item_cost",
	row_number() OVER (
		PARTITION BY "product_id"
		ORDER BY "item_cost" ASC NULLS LAST, "lead_time_days", "supplier_name", "supplier_id"
	) = 1 AS "cheapest"
FROM offers;--> statement-breakpoint
GRANT SELECT ON "catalogs", "supplier_catalogs", "purchase_order_excluded_catalogs", "supplier_offers" TO katasync_mcp;
