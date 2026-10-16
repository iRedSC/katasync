CREATE TABLE "purchase_order_sent_sets" (
	"purchase_order_id" integer NOT NULL,
	"set_product_id" integer NOT NULL,
	"sets" integer NOT NULL,
	CONSTRAINT "purchase_order_sent_sets_purchase_order_id_set_product_id_pk" PRIMARY KEY("purchase_order_id","set_product_id"),
	CONSTRAINT "purchase_order_sent_sets_positive" CHECK ("purchase_order_sent_sets"."sets" > 0)
);
--> statement-breakpoint
ALTER TABLE "purchase_order_sent_sets" ADD CONSTRAINT "purchase_order_sent_sets_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_sent_sets" ADD CONSTRAINT "purchase_order_sent_sets_set_product_id_products_id_fk" FOREIGN KEY ("set_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
GRANT SELECT ON "purchase_order_sent_sets" TO katasync_mcp;
