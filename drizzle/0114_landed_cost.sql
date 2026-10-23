CREATE TYPE "public"."cost_entry_kind" AS ENUM('opening', 'set', 'receipt', 'po_correction', 'return', 'kit_build', 'kit_break', 'undo');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_charge_kind" AS ENUM('freight', 'duty', 'fee', 'credit');--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cost_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" integer NOT NULL,
	"kind" "cost_entry_kind" NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"value" numeric(14, 4),
	"held_before" integer NOT NULL,
	"avg_before" numeric(12, 4),
	"avg_after" numeric(12, 4),
	"sold_value" numeric(14, 4) DEFAULT 0 NOT NULL,
	"batch_id" uuid,
	"purchase_order_line_id" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_charges" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_charges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"kind" "purchase_order_charge_kind" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_charges_sign" CHECK (case when "purchase_order_charges"."kind" = 'credit' then "purchase_order_charges"."amount" < 0 else "purchase_order_charges"."amount" > 0 end)
);
--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_charges" ADD CONSTRAINT "purchase_order_charges_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_entries_product_idx" ON "cost_entries" USING btree ("product_id","id");--> statement-breakpoint
CREATE INDEX "cost_entries_batch_idx" ON "cost_entries" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "cost_entries_po_line_idx" ON "cost_entries" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "cost_entries_created_idx" ON "cost_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "purchase_order_charges_po_idx" ON "purchase_order_charges" USING btree ("purchase_order_id");--> statement-breakpoint
-- Cost entries are history: never changed, and deleted only with a product
-- that never did anything (src/products/archive.ts), which has gone first.
CREATE FUNCTION keep_cost_entries() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "products" WHERE "id" = OLD."product_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'cost_entries are append-only; post a correcting entry instead';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "cost_entries_append_only" BEFORE UPDATE OR DELETE ON "cost_entries"
  FOR EACH ROW EXECUTE FUNCTION keep_cost_entries();
--> statement-breakpoint
-- However a product's cost is written: sales that went out while it had
-- none take its first one (a tool set's, once every part has one), and keep
-- it. A write that skips src/inventory/valuation.ts (an import, a fixture)
-- still leaves a cost entry; the valuation module writes its entry first, in
-- the same transaction, so this finds it.
CREATE FUNCTION log_direct_cost() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."unit_cost" IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW."unit_cost" IS NOT DISTINCT FROM OLD."unit_cost" THEN RETURN NULL; END IF;
  IF NEW."unit_cost" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."unit_cost" IS NULL) THEN
    IF NEW."kind" <> 'bundle' THEN
      UPDATE "order_lines" SET "unit_cost" = NEW."unit_cost"
      WHERE "product_id" = NEW."id" AND "unit_cost" IS NULL;
    END IF;
    UPDATE "order_lines" l SET "unit_cost" = s."cost"
    FROM (
      SELECT pc."parent_product_id" AS "id", sum(cp."unit_cost" * pc."quantity") AS "cost"
      FROM "product_components" pc
      JOIN "products" cp ON cp."id" = pc."component_product_id"
      WHERE pc."parent_product_id" IN (
        SELECT "parent_product_id" FROM "product_components" WHERE "component_product_id" = NEW."id"
      )
      GROUP BY pc."parent_product_id"
      HAVING bool_and(cp."unit_cost" IS NOT NULL)
    ) s
    WHERE l."product_id" = s."id" AND l."unit_cost" IS NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "cost_entries" e
    WHERE e."product_id" = NEW."id" AND e."created_at" = now()
      AND e."avg_after" IS NOT DISTINCT FROM NEW."unit_cost"
  ) THEN RETURN NULL; END IF;
  INSERT INTO "cost_entries" ("product_id", "kind", "held_before", "avg_before", "avg_after", "note")
  VALUES (
    NEW."id", 'set',
    (SELECT coalesce(sum(greatest(sl."on_hand", 0)), 0) FROM "stock_levels" sl WHERE sl."product_id" = NEW."id"),
    CASE WHEN TG_OP = 'UPDATE' THEN OLD."unit_cost" END,
    NEW."unit_cost",
    'Written directly'
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "products_cost_logged" AFTER INSERT OR UPDATE OF "unit_cost" ON "products"
  FOR EACH ROW EXECUTE FUNCTION log_direct_cost();
--> statement-breakpoint
-- Every cost today is where its history starts: what's on the shelf is worth
-- that much.
INSERT INTO "cost_entries" ("product_id", "kind", "value", "held_before", "avg_after", "note")
SELECT p."id", 'opening',
  coalesce(sum(greatest(sl."on_hand", 0)), 0) * p."unit_cost",
  coalesce(sum(greatest(sl."on_hand", 0)), 0)::int,
  p."unit_cost", 'Cost when tracking began'
FROM "products" p
LEFT JOIN "stock_levels" sl ON sl."product_id" = p."id"
WHERE p."unit_cost" IS NOT NULL
GROUP BY p."id";
--> statement-breakpoint
-- Sales with no cost of their own showed the product's cost as it is now, and
-- changed with it. They keep that number from here on.
UPDATE "order_lines" l SET "unit_cost" = c."cost"
FROM (
  SELECT p."id",
    CASE WHEN p."kind" = 'bundle' THEN (
      SELECT CASE WHEN count(*) > 0 AND bool_and(cp."unit_cost" IS NOT NULL)
        THEN sum(cp."unit_cost" * pc."quantity") END
      FROM "product_components" pc
      JOIN "products" cp ON cp."id" = pc."component_product_id"
      WHERE pc."parent_product_id" = p."id"
    ) ELSE p."unit_cost" END AS "cost"
  FROM "products" p
) c
WHERE l."product_id" = c."id" AND l."unit_cost" IS NULL AND c."cost" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW "order_line_costs" AS
WITH returns AS (
	SELECT "order_line_id",
		sum("quantity") AS "returned",
		-- Refurbished units are back on a shelf too, as their refurb, which
		-- carries their cost to its own sale.
		sum("quantity") FILTER (WHERE "restocked" OR "refurb_product_id" IS NOT NULL
			OR "pre_cutover") AS "restocked"
	FROM "order_returns" GROUP BY "order_line_id"
),
order_revenue AS (
	SELECT "order_id", sum("unit_price" * "quantity") AS "revenue"
	FROM "order_lines" GROUP BY "order_id"
),
-- Shipped from our shelf lately and refunded everything it charged, items
-- and shipping, by the marketplace it really sold on (as order_profit counts
-- refunds). Refunded shipping can't pass for refunded items: a partial
-- refund keeps its cost.
refunded AS (
	SELECT o."id" AS "order_id"
	FROM "orders" o
	JOIN "stores" st ON st."id" = o."store_id"
	JOIN order_revenue rv ON rv."order_id" = o."id" AND rv."revenue" > 0
	JOIN "order_charges" ch ON ch."order_id" = o."id" AND ch."kind" = 'refund'
		AND ch."billed_by" = coalesce(split_part(o."marketplace_order_id", ':', 1)::"channel", st."channel")
	WHERE NOT o."fulfilled_by_channel" AND o."cancelled_at" IS NULL
		AND o."placed_at" >= now() - interval '60 days'
		AND o."no_return_at" IS NULL
	GROUP BY o."id", rv."revenue", o."shipping_charged"
	HAVING sum(ch."amount") >= rv."revenue" + o."shipping_charged"
),
lines AS (
	-- As in 0054: a line sold under a listing tagged "intangible" (labor, a
	-- catalog) has no stock or cost.
	SELECT l.*,
		-- Its units left our shelf: it took stock, or it shipped before the
		-- store's cutover (which wiped sale batches; the opening count has
		-- those units gone). Custom items without a product never did.
		(l."sale_batch_id" IS NOT NULL OR (l."product_id" IS NOT NULL AND EXISTS (
			SELECT 1 FROM "orders" o
			JOIN "stores" st ON st."id" = o."store_id"
			WHERE o."id" = l."order_id" AND o."placed_at" < st."stock_from"
		))) AS "from_shelf",
		l."product_id" IS NULL AND EXISTS (
			SELECT 1 FROM "orders" o
			JOIN "listings" li ON li."store_id" = o."store_id"
				AND li."external_id" = l."listing_external_id"
			WHERE o."id" = l."order_id"
				AND EXISTS (SELECT 1 FROM unnest(li."tags") t WHERE lower(t) = 'intangible')
		) AS "intangible"
	FROM "order_lines" l
),
costed AS (
	SELECT
		l."id" AS "line_id",
		l."order_id",
		l."product_id",
		l."quantity",
		l."unit_price" * l."quantity" AS "revenue",
		-- What the sale took when its stock left. One taken while the product
		-- had no cost gets it once the product does (src/inventory/
		-- valuation.ts), and is unknown until then.
		CASE WHEN l."intangible" THEN 0 ELSE l."unit_cost" END AS "unit_cost",
		coalesce(r."restocked", 0) AS "restocked",
		l."intangible",
		l."from_shelf",
		-- Units off our shelf that haven't been received back yet.
		CASE WHEN rf."order_id" IS NOT NULL AND l."from_shelf"
			THEN l."quantity" - coalesce(r."returned", 0) ELSE 0 END AS "returning"
	FROM lines l
	LEFT JOIN returns r ON r."order_line_id" = l."id"
	LEFT JOIN refunded rf ON rf."order_id" = l."order_id"
)
SELECT
	"line_id",
	"order_id",
	"product_id",
	"quantity",
	"revenue",
	"unit_cost",
	"restocked",
	-- Units returned to the shelf, or on their way back, aren't a cost.
	"unit_cost" * ("quantity" - "restocked" - "returning") AS "cost",
	-- A line cancelled down to nothing costs nothing either way.
	("quantity" = 0 OR "intangible" OR ("product_id" IS NOT NULL AND "unit_cost" IS NOT NULL)) AS "cost_known",
	"returning",
	"from_shelf"
FROM costed;;
--> statement-breakpoint
-- What stock is worth on each shelf, at its product's average cost. Unknown
-- (null) where the product has no cost. Oversold shelves hold nothing.
CREATE VIEW "stock_value" AS
SELECT sl."product_id", sl."location_id", l."kind" AS "location_kind",
  sl."on_hand" AS "units", p."unit_cost",
  sl."on_hand" * p."unit_cost" AS "value"
FROM "stock_levels" sl
JOIN "products" p ON p."id" = sl."product_id"
JOIN "locations" l ON l."id" = sl."location_id"
WHERE sl."on_hand" > 0;
--> statement-breakpoint
GRANT SELECT ON "cost_entries", "purchase_order_charges", "stock_value" TO katasync_mcp;
