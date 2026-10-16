ALTER TABLE "settings" DROP CONSTRAINT "settings_stock_range";--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "default_min_stock" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "default_max_stock";--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_stock_range" CHECK ("settings"."default_min_stock" >= 0);--> statement-breakpoint
-- Max now comes from each product's forecast; min starts at 1 everywhere.
UPDATE "settings" SET "default_min_stock" = 1;
