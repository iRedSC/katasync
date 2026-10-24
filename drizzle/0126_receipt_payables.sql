CREATE TABLE "supplier_invoice_documents" (
	"invoice_id" integer PRIMARY KEY NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"freight_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_tx" text DEFAULT txid_current()::text NOT NULL,
	CONSTRAINT "supplier_invoice_documents_usd" CHECK ("supplier_invoice_documents"."currency" = 'USD'),
	CONSTRAINT "supplier_invoice_documents_extras_not_negative" CHECK ("supplier_invoice_documents"."freight_cents" >= 0 and "supplier_invoice_documents"."tax_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_invoice_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"invoice_id" integer NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"sku" text,
	"supplier_sku" text,
	"description" text,
	"po_line_id" integer,
	"unmatched_reason" text,
	"quantity" integer,
	"unit" text,
	"pack_size" integer,
	"unit_price" numeric(12, 4),
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "supplier_invoice_lines_position" UNIQUE("invoice_id","position"),
	CONSTRAINT "supplier_invoice_lines_kind" CHECK ("supplier_invoice_lines"."kind" in ('merchandise', 'credit')),
	CONSTRAINT "supplier_invoice_lines_position_positive" CHECK ("supplier_invoice_lines"."position" > 0),
	CONSTRAINT "supplier_invoice_lines_merchandise_shape" CHECK (("supplier_invoice_lines"."kind" = 'merchandise') = ("supplier_invoice_lines"."quantity" is not null and "supplier_invoice_lines"."unit" is not null and "supplier_invoice_lines"."pack_size" is not null and "supplier_invoice_lines"."unit_price" is not null)),
	CONSTRAINT "supplier_invoice_lines_matched_or_why" CHECK ("supplier_invoice_lines"."kind" = 'credit' or (("supplier_invoice_lines"."po_line_id" is null) <> ("supplier_invoice_lines"."unmatched_reason" is null))),
	CONSTRAINT "supplier_invoice_lines_credit_unmatched" CHECK ("supplier_invoice_lines"."kind" = 'merchandise' or ("supplier_invoice_lines"."po_line_id" is null and "supplier_invoice_lines"."unmatched_reason" is null)),
	CONSTRAINT "supplier_invoice_lines_amounts" CHECK (("supplier_invoice_lines"."quantity" is null or "supplier_invoice_lines"."quantity" >= 0) and ("supplier_invoice_lines"."pack_size" is null or "supplier_invoice_lines"."pack_size" > 0) and ("supplier_invoice_lines"."unit_price" is null or "supplier_invoice_lines"."unit_price" >= 0) and (case when "supplier_invoice_lines"."kind" = 'credit' then "supplier_invoice_lines"."amount_cents" > 0 else "supplier_invoice_lines"."amount_cents" >= 0 end))
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_openings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_invoice_openings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"invoice_id" integer NOT NULL,
	"paid_cents" bigint NOT NULL,
	"note" text,
	"asserted_by" text,
	"asserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_by" text,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "supplier_invoice_openings_paid" CHECK ("supplier_invoice_openings"."paid_cents" >= 0),
	CONSTRAINT "supplier_invoice_openings_withdraw_whole" CHECK ("supplier_invoice_openings"."withdrawn_by" is null or "supplier_invoice_openings"."withdrawn_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_voids" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_invoice_voids_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"invoice_id" integer NOT NULL,
	"reason" text,
	"voided_by" text,
	"voided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_by" text,
	"restored_at" timestamp with time zone,
	CONSTRAINT "supplier_invoice_voids_restore_whole" CHECK ("supplier_invoice_voids"."restored_by" is null or "supplier_invoice_voids"."restored_at" is not null),
	CONSTRAINT "supplier_invoice_voids_restored_after" CHECK ("supplier_invoice_voids"."restored_at" is null or "supplier_invoice_voids"."restored_at" >= "supplier_invoice_voids"."voided_at")
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"supplier_id" integer NOT NULL,
	"invoice_id" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"applied_by" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_by" text,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "supplier_payment_applications_positive" CHECK ("supplier_payment_applications"."amount_cents" > 0),
	CONSTRAINT "supplier_payment_applications_reversal_whole" CHECK ("supplier_payment_applications"."reversed_by" is null or "supplier_payment_applications"."reversed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"request_digest" text NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_by" text,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	CONSTRAINT "supplier_payments_id_supplier" UNIQUE("id","supplier_id"),
	CONSTRAINT "supplier_payments_usd" CHECK ("supplier_payments"."currency" = 'USD'),
	CONSTRAINT "supplier_payments_positive" CHECK ("supplier_payments"."amount_cents" > 0),
	CONSTRAINT "supplier_payments_method" CHECK ("supplier_payments"."method" in ('ach', 'check', 'card', 'wire', 'cash', 'other')),
	CONSTRAINT "supplier_payments_reversal_whole" CHECK (("supplier_payments"."reversed_by" is null and "supplier_payments"."reversal_reason" is null) or "supplier_payments"."reversed_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "supplier_invoice_documents" ADD CONSTRAINT "supplier_invoice_documents_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_invoice_id_supplier_invoice_documents_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoice_documents"("invoice_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_po_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_openings" ADD CONSTRAINT "supplier_invoice_openings_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_voids" ADD CONSTRAINT "supplier_invoice_voids_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_applications" ADD CONSTRAINT "supplier_payment_applications_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_applications" ADD CONSTRAINT "supplier_payment_applications_payment_fk" FOREIGN KEY ("payment_id","supplier_id") REFERENCES "public"."supplier_payments"("id","supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_invoice_lines_po_line_idx" ON "supplier_invoice_lines" USING btree ("po_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_openings_active" ON "supplier_invoice_openings" USING btree ("invoice_id") WHERE "supplier_invoice_openings"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "supplier_invoice_voids_invoice_idx" ON "supplier_invoice_voids" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_voids_open" ON "supplier_invoice_voids" USING btree ("invoice_id") WHERE "supplier_invoice_voids"."restored_at" is null;--> statement-breakpoint
CREATE INDEX "supplier_payment_applications_payment_idx" ON "supplier_payment_applications" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_applications_invoice_idx" ON "supplier_payment_applications" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_supplier_idx" ON "supplier_payments" USING btree ("supplier_id");