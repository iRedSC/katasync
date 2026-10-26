CREATE TYPE "public"."marketplace_case_kind" AS ENUM('inquiry', 'cancellation', 'dispute', 'claim', 'escalation');--> statement-breakpoint
CREATE TYPE "public"."marketplace_case_status" AS ENUM('open', 'processing', 'closed', 'cancelled', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."sync_feed" ADD VALUE 'cases';--> statement-breakpoint
ALTER TYPE "public"."sync_feed" ADD VALUE 'disputes';--> statement-breakpoint
CREATE TABLE "marketplace_cases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "marketplace_cases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"billed_by" "channel" NOT NULL,
	"kind" "marketplace_case_kind" NOT NULL,
	"external_id" text NOT NULL,
	"order_id" integer,
	"order_external_id" text,
	"related_return_request_id" integer,
	"raw_status" text NOT NULL,
	"status" "marketplace_case_status" NOT NULL,
	"waiting_on" "case_waiting_on" NOT NULL,
	"respond_by" timestamp with time zone,
	"next_action" text,
	"amount" numeric,
	"currency" text,
	"escalation" "case_escalation",
	"case_ref" text,
	"action_url" text,
	"requested_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_cases_channel_kind_external" UNIQUE("billed_by","kind","external_id"),
	CONSTRAINT "marketplace_cases_resolved_owner" CHECK (("marketplace_cases"."waiting_on" = 'nobody') = ("marketplace_cases"."status" in ('closed', 'cancelled'))),
	CONSTRAINT "marketplace_cases_deadline_owner" CHECK ("marketplace_cases"."respond_by" is null or "marketplace_cases"."waiting_on" = 'us'),
	CONSTRAINT "marketplace_cases_money_pair" CHECK (("marketplace_cases"."amount" is null) = ("marketplace_cases"."currency" is null))
);
--> statement-breakpoint
ALTER TABLE "marketplace_cases" ADD CONSTRAINT "marketplace_cases_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_cases" ADD CONSTRAINT "marketplace_cases_related_return_request_id_return_requests_id_fk" FOREIGN KEY ("related_return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketplace_cases_order_idx" ON "marketplace_cases" USING btree ("order_id");--> statement-breakpoint
DROP VIEW "open_cases";--> statement-breakpoint
CREATE VIEW "open_cases" AS
SELECT 'return'::text AS source, id, order_id, billed_by, external_id, case_ref,
 kind::text, status::text, waiting_on, respond_by, next_action, amount, currency, escalation
FROM return_requests WHERE waiting_on <> 'nobody'
UNION ALL
SELECT 'marketplace'::text AS source, id, order_id, billed_by, external_id, case_ref,
 kind::text, status::text, waiting_on, respond_by, next_action, amount, currency, escalation
FROM marketplace_cases WHERE waiting_on <> 'nobody'
ORDER BY respond_by NULLS LAST, source, id;--> statement-breakpoint
GRANT SELECT ON "marketplace_cases", "open_cases" TO katasync_mcp;
