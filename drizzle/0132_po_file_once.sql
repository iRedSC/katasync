ALTER TABLE "po_email_attachments" ADD COLUMN "sha256" text GENERATED ALWAYS AS (encode(sha256("data"), 'hex')) STORED;--> statement-breakpoint
ALTER TABLE "po_email_attachments" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_order_files" ADD COLUMN "sha256" text GENERATED ALWAYS AS (encode(sha256("data"), 'hex')) STORED NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_files_once" ON "purchase_order_files" USING btree ("purchase_order_id","sha256") WHERE "purchase_order_files"."removed_at" is null;