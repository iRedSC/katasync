-- Amazon's Pending orders were stored as unfulfilled, which put them on
-- To ship before payment cleared. They now wait for payment.
UPDATE "orders" SET "fulfillment_status" = 'AWAITING_PAYMENT', "pin" = NULL
WHERE "financial_status" = 'PENDING'
	AND "fulfillment_status" = 'UNFULFILLED'
	AND "store_id" IN (SELECT "id" FROM "stores" WHERE "channel" = 'amazon');
