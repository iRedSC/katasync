-- The unique constraint first: the invoice foreign key needs it.
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_id_supplier" UNIQUE("id","supplier_id");--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_invoices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"number" text NOT NULL,
	"invoiced_on" date NOT NULL,
	"due_on" date,
	"total" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoices_number_given" CHECK (btrim("supplier_invoices"."number") <> ''),
	CONSTRAINT "supplier_invoices_total_not_negative" CHECK ("supplier_invoices"."total" >= 0),
	CONSTRAINT "supplier_invoices_due_after_invoiced" CHECK ("supplier_invoices"."due_on" is null or "supplier_invoices"."due_on" >= "supplier_invoices"."invoiced_on")
);
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_po_fk" FOREIGN KEY ("purchase_order_id","supplier_id") REFERENCES "public"."purchase_orders"("id","supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_invoices_po_idx" ON "supplier_invoices" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoices_number" ON "supplier_invoices" USING btree ("supplier_id",lower("number"));
--> statement-breakpoint
GRANT SELECT ON "supplier_invoices" TO katasync_mcp;
