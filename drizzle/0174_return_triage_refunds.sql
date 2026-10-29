CREATE TYPE "public"."refund_decision" AS ENUM('full', 'partial', 'none', 'other');--> statement-breakpoint
CREATE TABLE "return_refunds" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "return_refunds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"decision" "refund_decision" NOT NULL,
	"amount" numeric(12, 2),
	"note" text,
	"refunded_before" numeric(12, 2) NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "return_refunds_amount_for_partial" CHECK (("return_refunds"."decision" = 'partial') = ("return_refunds"."amount" is not null) and ("return_refunds"."amount" is null or "return_refunds"."amount" > 0)),
	CONSTRAINT "return_refunds_other_says_what" CHECK ("return_refunds"."decision" <> 'other' or btrim(coalesce("return_refunds"."note", '')) <> ''),
	CONSTRAINT "return_refunds_refused_unsettled" CHECK ("return_refunds"."decision" <> 'none' or "return_refunds"."settled_at" is null)
);
--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "return_refunds" ADD CONSTRAINT "return_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "return_refunds_order_idx" ON "return_refunds" USING btree ("order_id","decided_at");--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_note_given" CHECK ("order_returns"."note" is null or btrim("order_returns"."note") <> '');--> statement-breakpoint
-- Claude reads it like every other table (src/mcp/query.ts).
GRANT SELECT ON "return_refunds" TO katasync_mcp;
