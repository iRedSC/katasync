-- When a sync last asked the marketplace again for an order whose shipped
-- count is unknown (src/channels/unknown-shipped.ts), so orders that keep
-- failing go to the back of the queue instead of starving the rest.
ALTER TABLE "orders" ADD COLUMN "shipped_checked_at" timestamp with time zone;