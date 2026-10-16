CREATE TABLE "count_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "count_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expected" integer NOT NULL,
	"counted" integer NOT NULL,
	"batch_id" uuid,
	CONSTRAINT "count_log_batchId_unique" UNIQUE("batch_id"),
	CONSTRAINT "count_log_batch_when_off" CHECK (("count_log"."batch_id" is null) = ("count_log"."expected" = "count_log"."counted"))
);
--> statement-breakpoint
ALTER TABLE "count_log" ADD CONSTRAINT "count_log_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "count_log" ADD CONSTRAINT "count_log_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "count_log_product_idx" ON "count_log" USING btree ("product_id","counted_at");--> statement-breakpoint
-- No backfill. Older counts that moved stock are in stock_counts, but what
-- the count expected can't be rebuilt reliably: a sale's movement can take a
-- lower id yet land on the shelf after the count, so a ledger sum by id would
-- record wrong history. The log starts empty instead.
--> statement-breakpoint
-- Each count with its drift (counted minus expected), and whether it was
-- undone afterwards, so a mistyped count doesn't read as drift.
CREATE VIEW "count_history" AS
SELECT
	c."id",
	c."product_id",
	p."sku",
	c."location_id",
	c."counted_at",
	c."expected",
	c."counted",
	c."counted" - c."expected" AS "drift",
	EXISTS (
		SELECT FROM "movements" m WHERE m."reference" = 'undo:' || c."batch_id"::text
	) AS "undone"
FROM "count_log" c
JOIN "products" p ON p."id" = c."product_id";
--> statement-breakpoint
GRANT SELECT ON "count_log", "count_history" TO katasync_mcp;
