-- Shopify mirrors the returns on TikTok orders it relayed. Until TikTok's own
-- returns could be read, those mirrors were imported; now TikTok's are, and
-- the Shopify importer skips the mirrors. Left behind they'd never update
-- again, so an open one could keep an order on Due back after TikTok closed
-- it. They're copies of what TikTok's import brings in, so nothing is lost.
-- Their lines go with them (on delete cascade).
DELETE FROM "return_requests" rr
USING "orders" o
WHERE rr."order_id" = o."id"
	AND rr."billed_by" = 'shopify'
	AND o."marketplace_order_id" LIKE 'tiktok:%';
