ALTER TABLE "buyer_messages" ADD COLUMN "media" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Amazon messages already threaded take their emails' files.
UPDATE "buyer_messages" m SET "media" = f.media
FROM (
	SELECT "email_id", jsonb_agg(jsonb_build_object(
		'kind', CASE WHEN "content_type" LIKE 'image/%' THEN 'IMAGE' ELSE 'FILE' END,
		'name', "filename",
		'url', '/api/market-email-attachments/' || "id"
	) ORDER BY "id") AS media
	FROM "market_email_attachments"
	WHERE "content_id" IS NULL
	GROUP BY "email_id"
) f
WHERE m."market_email_id" = f."email_id";--> statement-breakpoint
-- eBay's conversations are read again in full, a month back, so messages
-- kept before their pictures get them.
UPDATE "buyer_threads" SET "read_latest_id" = NULL WHERE "market" = 'ebay';--> statement-breakpoint
UPDATE "buyer_message_checks" SET "read_through" = NULL WHERE "market" = 'ebay';
