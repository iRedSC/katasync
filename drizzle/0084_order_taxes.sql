CREATE TYPE "public"."tax_remitter" AS ENUM('marketplace', 'seller');--> statement-breakpoint
CREATE TABLE "order_taxes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_taxes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"jurisdiction" text NOT NULL,
	"rate" numeric(8, 6),
	"amount" numeric(12, 2) NOT NULL,
	CONSTRAINT "order_taxes_amount_not_zero" CHECK ("order_taxes"."amount" <> 0),
	CONSTRAINT "order_taxes_jurisdiction_given" CHECK (btrim("order_taxes"."jurisdiction") <> '')
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_remitted_by" "tax_remitter";--> statement-breakpoint
ALTER TABLE "order_taxes" ADD CONSTRAINT "order_taxes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_taxes_order_idx" ON "order_taxes" USING btree ("order_id");--> statement-breakpoint
-- The read-only MCP role sees sales tax like every other table.
GRANT SELECT ON "order_taxes" TO katasync_mcp;