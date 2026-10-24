-- 0086 received every fully refunded order from before cutover as returned.
-- This one was cancelled on Amazon (which still shows it unshipped) and never
-- left the shelf, so nothing came back. Its refund now reads as refunded.
DELETE FROM "order_returns"
WHERE "pre_cutover"
	AND "order_line_id" IN (
		SELECT l."id" FROM "order_lines" l
		JOIN "orders" o ON o."id" = l."order_id"
		WHERE o."name" = '114-3895464-0384252'
	);
