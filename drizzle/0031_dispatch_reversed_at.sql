ALTER TABLE "dispatch_orders" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
-- Dispatches already fully voided finished voiding before this existed.
UPDATE "dispatch_orders" SET "reversed_at" = now()
	WHERE NOT EXISTS (
		SELECT 1 FROM "shipments" s
		WHERE s."dispatch_id" = "dispatch_orders"."dispatch_id" AND s."voided_at" IS NULL
	);
