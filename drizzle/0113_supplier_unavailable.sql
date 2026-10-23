CREATE TABLE "supplier_unavailable" (
	"supplier_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_unavailable_supplier_id_product_id_pk" PRIMARY KEY("supplier_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "supplier_unavailable" ADD CONSTRAINT "supplier_unavailable_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_unavailable" ADD CONSTRAINT "supplier_unavailable_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_unavailable_product_idx" ON "supplier_unavailable" USING btree ("product_id");--> statement-breakpoint
-- supplier_offers as in 0109, leaving out what a supplier has marked
-- unavailable, so reorder buys it elsewhere.
CREATE OR REPLACE VIEW "supplier_offers" AS
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
		AND NOT EXISTS (
			SELECT 1 FROM "supplier_unavailable" su
			WHERE su."supplier_id" = sc."supplier_id" AND su."product_id" = p."id"
		)
)
SELECT
	"product_id", "supplier_id", "catalog_id", "supplier_sku", "unit",
	"pack_size", "supplier_count", "cost", "minimum_quantity", "item_cost",
	row_number() OVER (
		PARTITION BY "product_id"
		ORDER BY "item_cost" ASC NULLS LAST, "lead_time_days", "supplier_name", "supplier_id"
	) = 1 AS "cheapest"
FROM offers;--> statement-breakpoint
-- Claude reads it like every other table (src/mcp/query.ts).
GRANT SELECT ON "supplier_unavailable" TO katasync_mcp;
