ALTER TABLE "movements" DROP CONSTRAINT "movements_delta_nonzero";--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "stock_push" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "not_counted_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "close_at" integer;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "push_stock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "stock_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "stock_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "stock_push_error" text;--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_delta_nonzero" CHECK ("movements"."delta" <> 0 or "movements"."reason" = 'opening_balance');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_close_at_positive" CHECK ("products"."close_at" > 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_bundle_never_uncounted" CHECK ("products"."kind" <> 'bundle' or "products"."not_counted_since" is null);