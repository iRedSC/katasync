CREATE TYPE "public"."damage_kind" AS ENUM('damaged', 'missing');--> statement-breakpoint
ALTER TABLE "purchase_order_damages" DROP CONSTRAINT "purchase_order_damages_description_given";--> statement-breakpoint
ALTER TABLE "purchase_order_damages" ALTER COLUMN "description" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_damages" ADD COLUMN "kind" "damage_kind" DEFAULT 'damaged' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_damages" ADD CONSTRAINT "purchase_order_damages_description_given" CHECK ("purchase_order_damages"."kind" = 'missing' or ("purchase_order_damages"."description" is not null and btrim("purchase_order_damages"."description") <> ''));