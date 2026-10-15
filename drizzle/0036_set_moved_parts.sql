CREATE TABLE "purchase_order_moved_parts" (
	"line_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	CONSTRAINT "purchase_order_moved_parts_line_id_product_id_pk" PRIMARY KEY("line_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "purchase_order_moved_parts" ADD CONSTRAINT "purchase_order_moved_parts_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_moved_parts" ADD CONSTRAINT "purchase_order_moved_parts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
GRANT SELECT ON "purchase_order_moved_parts" TO katasync_mcp;
