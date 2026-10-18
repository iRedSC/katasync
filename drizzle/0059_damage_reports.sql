CREATE TYPE "public"."damage_remedy" AS ENUM('credit', 'replacement');--> statement-breakpoint
CREATE TABLE "damage_photo_uploads" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"damage_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_damage_photos" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_damage_photos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"damage_id" integer NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_damage_photos_type" CHECK ("purchase_order_damage_photos"."content_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "purchase_order_damage_photos_size" CHECK (octet_length("purchase_order_damage_photos"."data") between 1 and 4500000)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_damage_reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_damage_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"sent_to" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_damages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_damages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"line_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"description" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"report_id" integer,
	"remedy" "damage_remedy",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_damages_batchId_unique" UNIQUE("batch_id"),
	CONSTRAINT "purchase_order_damages_quantity_positive" CHECK ("purchase_order_damages"."quantity" > 0),
	CONSTRAINT "purchase_order_damages_description_given" CHECK (btrim("purchase_order_damages"."description") <> ''),
	CONSTRAINT "purchase_order_damages_reported_with_remedy" CHECK (("purchase_order_damages"."report_id" is null) = ("purchase_order_damages"."remedy" is null))
);
--> statement-breakpoint
ALTER TABLE "damage_photo_uploads" ADD CONSTRAINT "damage_photo_uploads_damage_id_purchase_order_damages_id_fk" FOREIGN KEY ("damage_id") REFERENCES "public"."purchase_order_damages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_damage_photos" ADD CONSTRAINT "purchase_order_damage_photos_damage_id_purchase_order_damages_id_fk" FOREIGN KEY ("damage_id") REFERENCES "public"."purchase_order_damages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_damage_reports" ADD CONSTRAINT "purchase_order_damage_reports_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_damages" ADD CONSTRAINT "purchase_order_damages_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_damages" ADD CONSTRAINT "purchase_order_damages_report_id_purchase_order_damage_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."purchase_order_damage_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_order_damage_photos_damage_idx" ON "purchase_order_damage_photos" USING btree ("damage_id");--> statement-breakpoint
CREATE INDEX "purchase_order_damage_reports_po_idx" ON "purchase_order_damage_reports" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_damages_line_idx" ON "purchase_order_damages" USING btree ("line_id");--> statement-breakpoint
-- The query tool can read damage and its photos, but not the upload links
-- (see drizzle/0027_mcp_role.sql and SECRET_TABLES).
GRANT SELECT ON "purchase_order_damage_reports", "purchase_order_damages", "purchase_order_damage_photos" TO katasync_mcp;
