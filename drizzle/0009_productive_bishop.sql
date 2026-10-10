ALTER TABLE "orders" DROP CONSTRAINT "orders_pin_three_digits";--> statement-breakpoint
ALTER TABLE "packages" DROP CONSTRAINT "packages_pin_three_digits";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pin_range" CHECK ("orders"."pin" between 1 and 999);--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_pin_range" CHECK ("packages"."pin" between 1 and 999);--> statement-breakpoint
-- Re-issue pins under the new shortest-first rule on the next sync.
UPDATE "orders" SET "pin" = NULL;
