ALTER TABLE "purchase_order_receipts" ADD CONSTRAINT "purchase_order_receipts_id_line" UNIQUE("id","line_id");--> statement-breakpoint
CREATE TABLE "purchase_order_discounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_discounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"line_id" integer NOT NULL,
	"units" integer,
	"percent" numeric(5, 2),
	"amount" numeric(12, 2),
	"receipt_id" integer,
	"sent" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_discounts_units_positive" CHECK ("purchase_order_discounts"."units" is null or "purchase_order_discounts"."units" > 0),
	CONSTRAINT "purchase_order_discounts_one_kind" CHECK (("purchase_order_discounts"."percent" is null) <> ("purchase_order_discounts"."amount" is null)),
	CONSTRAINT "purchase_order_discounts_percent_range" CHECK ("purchase_order_discounts"."percent" is null or ("purchase_order_discounts"."percent" > 0 and "purchase_order_discounts"."percent" <= 100)),
	CONSTRAINT "purchase_order_discounts_amount_positive" CHECK ("purchase_order_discounts"."amount" is null or "purchase_order_discounts"."amount" > 0),
	CONSTRAINT "purchase_order_discounts_receipt_units" CHECK ("purchase_order_discounts"."receipt_id" is null or "purchase_order_discounts"."units" is not null),
	CONSTRAINT "purchase_order_discounts_removed_was_sent" CHECK ("purchase_order_discounts"."removed_at" is null or "purchase_order_discounts"."sent")
);
--> statement-breakpoint
ALTER TABLE "purchase_order_discounts" ADD CONSTRAINT "purchase_order_discounts_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_discounts" ADD CONSTRAINT "purchase_order_discounts_receipt_id_line_id_purchase_order_receipts_id_line_id_fk" FOREIGN KEY ("receipt_id","line_id") REFERENCES "public"."purchase_order_receipts"("id","line_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_order_discounts_line_idx" ON "purchase_order_discounts" USING btree ("line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_discounts_one_rest" ON "purchase_order_discounts" USING btree ("line_id") WHERE "purchase_order_discounts"."units" is null and "purchase_order_discounts"."removed_at" is null;
--> statement-breakpoint
-- MCP reads it like any other PO table (src/mcp/query.ts).
GRANT SELECT ON "purchase_order_discounts" TO katasync_mcp;
