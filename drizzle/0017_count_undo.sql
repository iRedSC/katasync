CREATE TABLE "stock_counts" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_counted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;