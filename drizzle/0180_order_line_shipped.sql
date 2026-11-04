-- How many units of each line the marketplace says already went out, so a
-- partly shipped order packs only what's left (src/orders/remaining.ts).
-- Null is unknown, never none. Orders whose status settles it are filled in
-- here: none for unshipped or unpaid ones, all for finished ones. Every other
-- status (partly shipped, on hold, scheduled) can hide shipped units, so its
-- lines stay unknown until the next sync reads them from the channel.
ALTER TABLE "order_lines" ADD COLUMN "shipped_quantity" integer;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_shipped_quantity_nonnegative" CHECK ("order_lines"."shipped_quantity" >= 0);--> statement-breakpoint
UPDATE "order_lines" SET "shipped_quantity" = CASE
  WHEN o."fulfillment_status" IN ('FULFILLED', 'FULFILLMENT_NOT_REQUIRED') THEN "order_lines"."quantity"
  ELSE 0
END
FROM "orders" o
WHERE o."id" = "order_lines"."order_id"
  AND o."fulfillment_status" IN ('UNFULFILLED', 'AWAITING_PAYMENT', 'FULFILLED', 'FULFILLMENT_NOT_REQUIRED');
