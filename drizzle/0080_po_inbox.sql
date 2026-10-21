CREATE TYPE "public"."po_email_match" AS ENUM('address', 'subject', 'staff', 'claude');--> statement-breakpoint
CREATE TYPE "public"."tracking_status" AS ENUM('PRE_TRANSIT', 'TRANSIT', 'DELIVERED', 'RETURNED', 'FAILURE', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "po_email_attachments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "po_email_attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email_id" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea",
	"text" text,
	CONSTRAINT "po_email_attachments_size" CHECK ("po_email_attachments"."size" >= 0),
	CONSTRAINT "po_email_attachments_data_size" CHECK ("po_email_attachments"."data" is null or octet_length("po_email_attachments"."data") = "po_email_attachments"."size")
);
--> statement-breakpoint
CREATE TABLE "po_emails" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "po_emails_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" text NOT NULL,
	"purchase_order_id" integer,
	"matched_by" "po_email_match",
	"set_aside_at" timestamp with time zone,
	"from_address" text NOT NULL,
	"from_name" text,
	"recipients" text[] NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "po_emails_matched_with_po" CHECK (("po_emails"."purchase_order_id" is null) = ("po_emails"."matched_by" is null)),
	CONSTRAINT "po_emails_set_aside_unfiled" CHECK ("po_emails"."set_aside_at" is null or "po_emails"."purchase_order_id" is null)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_tracking" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_tracking_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"carrier" text NOT NULL,
	"number" text NOT NULL,
	"email_id" integer,
	"status" "tracking_status",
	"status_detail" text,
	"status_at" timestamp with time zone,
	"eta" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_tracking_number_shape" CHECK ("purchase_order_tracking"."number" ~ '^[0-9A-Z]{8,40}$'),
	CONSTRAINT "purchase_order_tracking_carrier" CHECK ("purchase_order_tracking"."carrier" in ('ups', 'usps', 'fedex'))
);
--> statement-breakpoint
ALTER TABLE "po_email_attachments" ADD CONSTRAINT "po_email_attachments_email_id_po_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."po_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_emails" ADD CONSTRAINT "po_emails_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_tracking" ADD CONSTRAINT "purchase_order_tracking_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_tracking" ADD CONSTRAINT "purchase_order_tracking_email_id_po_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."po_emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "po_email_attachments_email_idx" ON "po_email_attachments" USING btree ("email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_emails_message_id" ON "po_emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "po_emails_po_idx" ON "po_emails" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_tracking_number" ON "purchase_order_tracking" USING btree ("purchase_order_id","number");--> statement-breakpoint
GRANT SELECT ON "po_emails", "po_email_attachments", "purchase_order_tracking" TO katasync_mcp;
