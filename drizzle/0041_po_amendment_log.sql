CREATE TYPE "public"."purchase_order_amendment_kind" AS ENUM('added', 'removed', 'quantity', 'cost');--> statement-breakpoint
CREATE TABLE "purchase_order_amendments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_amendments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"kind" "purchase_order_amendment_kind" NOT NULL,
	"quantity_before" integer,
	"quantity_after" integer,
	"unit_cost_before" numeric(12, 4),
	"unit_cost_after" numeric(12, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_amendments_shape" CHECK (case "purchase_order_amendments"."kind"
				when 'added' then "purchase_order_amendments"."quantity_after" is not null and "purchase_order_amendments"."quantity_before" is null
				when 'removed' then "purchase_order_amendments"."quantity_before" is not null and "purchase_order_amendments"."quantity_after" is null
				when 'quantity' then "purchase_order_amendments"."quantity_before" is not null and "purchase_order_amendments"."quantity_after" is not null
				else "purchase_order_amendments"."quantity_before" is null and "purchase_order_amendments"."quantity_after" is null
			end)
);
--> statement-breakpoint
ALTER TABLE "purchase_order_amendments" ADD CONSTRAINT "purchase_order_amendments_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_amendments" ADD CONSTRAINT "purchase_order_amendments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_order_amendments_po_idx" ON "purchase_order_amendments" USING btree ("purchase_order_id");