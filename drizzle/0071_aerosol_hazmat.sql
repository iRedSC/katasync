ALTER TABLE "products" ADD COLUMN "aerosol" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "hazmat" boolean DEFAULT false NOT NULL;