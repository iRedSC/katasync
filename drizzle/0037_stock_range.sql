CREATE TABLE "settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"default_min_stock" integer DEFAULT 0 NOT NULL,
	"default_max_stock" integer DEFAULT 20 NOT NULL,
	CONSTRAINT "settings_single" CHECK ("settings"."id" = 1),
	CONSTRAINT "settings_stock_range" CHECK ("settings"."default_min_stock" >= 0 and "settings"."default_max_stock" > "settings"."default_min_stock")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "min_stock" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "max_stock" integer;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_stock_range" CHECK (("products"."min_stock" is null and "products"."max_stock" is null) or ("products"."min_stock" is not null and "products"."max_stock" is not null and "products"."min_stock" >= 0 and "products"."max_stock" > "products"."min_stock"));--> statement-breakpoint
INSERT INTO "settings" DEFAULT VALUES;--> statement-breakpoint
GRANT SELECT ON "settings" TO katasync_mcp;
