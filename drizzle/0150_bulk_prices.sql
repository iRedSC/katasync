ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_pack" UNIQUE("product_id","supplier_id","pack_size");--> statement-breakpoint
CREATE TABLE "product_bulk_prices" (
	"product_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"pack_size" integer NOT NULL,
	"min_quantity" integer NOT NULL,
	"cost" numeric(12, 4) NOT NULL,
	CONSTRAINT "product_bulk_prices_product_id_supplier_id_min_quantity_pk" PRIMARY KEY("product_id","supplier_id","min_quantity"),
	CONSTRAINT "product_bulk_prices_min_above_one" CHECK ("product_bulk_prices"."min_quantity" > 1),
	CONSTRAINT "product_bulk_prices_cost_not_negative" CHECK ("product_bulk_prices"."cost" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product_bulk_prices" ADD CONSTRAINT "product_bulk_prices_terms_fk" FOREIGN KEY ("product_id","supplier_id","pack_size") REFERENCES "public"."product_suppliers"("product_id","supplier_id","pack_size") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- What a supplier charges per unit for an order of p_quantity units of
-- p_pack: the lowest of its price and every bulk price the quantity reaches.
-- Null when it doesn't sell the product in that pack size, or has no price
-- that applies. Mirrors priceAt in src/purchasing/bulk.ts.
CREATE FUNCTION "bulk_price"(p_product integer, p_supplier integer, p_pack integer, p_quantity integer)
RETURNS numeric LANGUAGE sql STABLE AS $$
	SELECT least(o."cost", (
		SELECT min(b."cost") FROM "product_bulk_prices" b
		WHERE b."product_id" = o."product_id"
			AND b."supplier_id" = o."supplier_id"
			AND b."pack_size" = o."pack_size"
			AND b."min_quantity" <= p_quantity
	))
	FROM "supplier_offers" o
	WHERE o."product_id" = p_product
		AND o."supplier_id" = p_supplier
		AND o."pack_size" = p_pack
$$;--> statement-breakpoint
-- Draft and suggested lines follow their supplier's bulk prices, whoever
-- writes them. A new line at the supplier's price starts at the price for
-- its quantity. A line still at the price for its quantity moves with it
-- when only its quantity changes. A price set by hand, in the same write or
-- before, stays: the supplier may not honor a bulk price this time. Lines in
-- other terms than the supplier's, and sent POs, are never touched.
CREATE FUNCTION "purchase_order_lines_bulk_price"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	o record;
BEGIN
	-- Most products have none, so that's checked first, by the key alone.
	IF NOT EXISTS (
		SELECT 1 FROM "purchase_orders" po
		JOIN "product_bulk_prices" b
			ON b."product_id" = NEW."product_id" AND b."supplier_id" = po."supplier_id"
		WHERE po."id" = NEW."purchase_order_id"
			AND po."status" IN ('suggested', 'draft')
	) THEN RETURN NEW; END IF;
	SELECT so."cost", so."supplier_id" INTO o
	FROM "purchase_orders" po
	JOIN "supplier_offers" so
		ON so."supplier_id" = po."supplier_id" AND so."product_id" = NEW."product_id"
	WHERE po."id" = NEW."purchase_order_id"
		AND so."pack_size" = NEW."pack_size";
	IF NOT FOUND THEN RETURN NEW; END IF;
	IF TG_OP = 'INSERT' THEN
		IF NEW."unit_cost" IS NOT DISTINCT FROM o."cost" THEN
			NEW."unit_cost" := "bulk_price"(NEW."product_id", o."supplier_id", NEW."pack_size", NEW."quantity");
		END IF;
	ELSIF NEW."quantity" <> OLD."quantity"
		AND NEW."pack_size" = OLD."pack_size"
		AND NEW."unit_cost" IS NOT DISTINCT FROM OLD."unit_cost"
		AND OLD."unit_cost" IS NOT DISTINCT FROM "bulk_price"(NEW."product_id", o."supplier_id", OLD."pack_size", OLD."quantity")
	THEN
		NEW."unit_cost" := "bulk_price"(NEW."product_id", o."supplier_id", NEW."pack_size", NEW."quantity");
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "purchase_order_lines_bulk_price" BEFORE INSERT OR UPDATE OF "quantity" ON "purchase_order_lines"
	FOR EACH ROW EXECUTE FUNCTION "purchase_order_lines_bulk_price"();--> statement-breakpoint
-- Claude reads it like every other table (src/mcp/query.ts).
GRANT SELECT ON "product_bulk_prices" TO katasync_mcp;
