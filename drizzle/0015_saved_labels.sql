ALTER TABLE "shipments" ALTER COLUMN "label_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "label_pdf" "bytea";