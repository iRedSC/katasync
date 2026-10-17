CREATE TYPE "public"."charge_kind" AS ENUM('fee', 'label', 'refund', 'adjustment');--> statement-breakpoint
CREATE TABLE "order_charges" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_charges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"billed_by" "channel" NOT NULL,
	"kind" charge_kind NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	CONSTRAINT "order_charges_amount_not_zero" CHECK ("order_charges"."amount" <> 0),
	CONSTRAINT "order_charges_description_given" CHECK (btrim("order_charges"."description") <> '')
);
--> statement-breakpoint
CREATE TABLE "order_cost_checks" (
	"order_id" integer NOT NULL,
	"billed_by" "channel" NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"error" text,
	CONSTRAINT "order_cost_checks_order_id_billed_by_pk" PRIMARY KEY("order_id","billed_by")
);
--> statement-breakpoint
CREATE TABLE "order_cost_reports" (
	"order_id" integer NOT NULL,
	"billed_by" "channel" NOT NULL,
	"settled" boolean NOT NULL,
	"no_label" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_cost_reports_order_id_billed_by_pk" PRIMARY KEY("order_id","billed_by")
);
--> statement-breakpoint
ALTER TABLE "order_charges" ADD CONSTRAINT "order_charges_report_fk" FOREIGN KEY ("order_id","billed_by") REFERENCES "public"."order_cost_reports"("order_id","billed_by") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cost_checks" ADD CONSTRAINT "order_cost_checks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cost_reports" ADD CONSTRAINT "order_cost_reports_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_charges_report_idx" ON "order_charges" USING btree ("order_id","billed_by");--> statement-breakpoint
GRANT SELECT ON "order_cost_reports", "order_charges", "order_cost_checks" TO katasync_mcp;
