CREATE TYPE "public"."po_file_source" AS ENUM('staff', 'claude');--> statement-breakpoint
CREATE TABLE "po_file_uploads" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_files" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"text" text,
	"added_by" "po_file_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "purchase_order_files_named" CHECK (btrim("purchase_order_files"."filename") <> ''),
	CONSTRAINT "purchase_order_files_size" CHECK ("purchase_order_files"."size" between 1 and 4500000 and octet_length("purchase_order_files"."data") = "purchase_order_files"."size")
);
--> statement-breakpoint
ALTER TABLE "po_file_uploads" ADD CONSTRAINT "po_file_uploads_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_files" ADD CONSTRAINT "purchase_order_files_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_order_files_po_idx" ON "purchase_order_files" USING btree ("purchase_order_id");--> statement-breakpoint
-- Claude's SQL reads a PO's files like its emails'; upload links stay secret (src/mcp/query.ts).
GRANT SELECT ON "purchase_order_files" TO katasync_mcp;