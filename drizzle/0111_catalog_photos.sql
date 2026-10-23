CREATE TABLE "catalog_photos" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_photos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_photos_type" CHECK ("catalog_photos"."content_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "catalog_photos_size" CHECK (octet_length("catalog_photos"."data") between 1 and 2000000)
);
--> statement-breakpoint
ALTER TABLE "catalogs" ADD COLUMN "photo_id" integer;--> statement-breakpoint
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_photo_id_catalog_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."catalog_photos"("id") ON DELETE set null ON UPDATE no action;