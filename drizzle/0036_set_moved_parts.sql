CREATE TABLE "purchase_order_moved_parts" (
	"purchase_order_id" integer NOT NULL,
	"set_product_id" integer NOT NULL,
	"part_product_id" integer NOT NULL,
	CONSTRAINT "purchase_order_moved_parts_purchase_order_id_set_product_id_part_product_id_pk" PRIMARY KEY("purchase_order_id","set_product_id","part_product_id")
);
--> statement-breakpoint
ALTER TABLE "purchase_order_moved_parts" ADD CONSTRAINT "purchase_order_moved_parts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_moved_parts" ADD CONSTRAINT "purchase_order_moved_parts_set_product_id_products_id_fk" FOREIGN KEY ("set_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_moved_parts" ADD CONSTRAINT "purchase_order_moved_parts_part_product_id_products_id_fk" FOREIGN KEY ("part_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
GRANT SELECT ON "purchase_order_moved_parts" TO katasync_mcp;
