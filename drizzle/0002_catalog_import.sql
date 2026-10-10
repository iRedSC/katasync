ALTER TYPE "public"."movement_reason" ADD VALUE 'opening_balance';--> statement-breakpoint
CREATE TABLE "product_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;