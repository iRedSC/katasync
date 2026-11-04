-- How many units of each line the marketplace says already went out, so a
-- partly shipped order packs only what's left (src/orders/remaining.ts).
-- Null is unknown, never none. Open and finished orders are filled in from
-- their status here; a partly shipped order's lines stay unknown until its
-- next sync reads them from the channel.
ALTER TABLE "order_lines" ADD COLUMN "shipped_quantity" integer;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_shipped_quantity_nonnegative" CHECK ("order_lines"."shipped_quantity" >= 0);--> statement-breakpoint
UPDATE "order_lines" SET "shipped_quantity" = CASE
  WHEN o."fulfillment_status" IN ('FULFILLED', 'FULFILLMENT_NOT_REQUIRED') THEN "order_lines"."quantity"
  ELSE 0
END
FROM "orders" o
WHERE o."id" = "order_lines"."order_id"
  AND o."fulfillment_status" IN ('UNFULFILLED', 'ON_HOLD', 'AWAITING_PAYMENT', 'FULFILLED', 'FULFILLMENT_NOT_REQUIRED');
