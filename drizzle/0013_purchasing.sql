CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'sent', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "product_suppliers" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"supplier_sku" text,
	"cost" numeric(12, 4),
	"minimum_quantity" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_suppliers_minimum_positive" CHECK ("product_suppliers"."minimum_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(12, 4),
	CONSTRAINT "purchase_order_lines_product" UNIQUE("purchase_order_id","product_id"),
	CONSTRAINT "purchase_order_lines_quantity_positive" CHECK ("purchase_order_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_receipts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"line_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"batch_id" uuid NOT NULL,
	"undoes_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_receipts_batchId_unique" UNIQUE("batch_id"),
	CONSTRAINT "purchase_order_receipts_undoesId_unique" UNIQUE("undoes_id"),
	CONSTRAINT "purchase_order_receipts_quantity_nonzero" CHECK ("purchase_order_receipts"."quantity" <> 0),
	CONSTRAINT "purchase_order_receipts_undo_is_negative" CHECK (("purchase_order_receipts"."undoes_id" is null) = ("purchase_order_receipts"."quantity" > 0))
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1001 CACHE 1),
	"supplier_id" integer NOT NULL,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"location_id" integer NOT NULL,
	"notes" text,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"expected_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "suppliers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"address1" text,
	"address2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country" text,
	"payment_terms" text,
	"notes" text,
	"po_notes" text,
	"lead_time_days" integer DEFAULT 14 NOT NULL,
	"cover_days" integer DEFAULT 30 NOT NULL,
	"minimum_order" numeric(12, 2) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" ADD CONSTRAINT "purchase_order_receipts_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" ADD CONSTRAINT "purchase_order_receipts_undoes_id_purchase_order_receipts_id_fk" FOREIGN KEY ("undoes_id") REFERENCES "public"."purchase_order_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_suppliers_supplier_idx" ON "product_suppliers" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_order_receipts_line_idx" ON "purchase_order_receipts" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_one_draft" ON "purchase_orders" USING btree ("supplier_id") WHERE "purchase_orders"."status" = 'draft';