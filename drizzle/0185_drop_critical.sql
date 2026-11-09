ALTER TABLE "suppliers" DROP CONSTRAINT "suppliers_critical_threshold_positive";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "critical";--> statement-breakpoint
ALTER TABLE "suppliers" DROP COLUMN "critical_threshold";