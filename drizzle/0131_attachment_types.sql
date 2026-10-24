-- Some mailers label every attachment application/octet-stream, so PDFs
-- downloaded instead of opening; the name decides, as for new mail.
UPDATE "po_email_attachments" SET "content_type" = CASE
	WHEN "filename" ~* '\.pdf$' THEN 'application/pdf'
	WHEN "filename" ~* '\.eml$' THEN 'message/rfc822'
	WHEN "filename" ~* '\.png$' THEN 'image/png'
	WHEN "filename" ~* '\.jpe?g$' THEN 'image/jpeg'
END
WHERE "content_type" IN ('', 'application/octet-stream')
	AND "filename" ~* '\.(pdf|eml|png|jpe?g)$';--> statement-breakpoint
UPDATE "market_email_attachments" SET "content_type" = CASE
	WHEN "filename" ~* '\.pdf$' THEN 'application/pdf'
	WHEN "filename" ~* '\.eml$' THEN 'message/rfc822'
	WHEN "filename" ~* '\.png$' THEN 'image/png'
	WHEN "filename" ~* '\.jpe?g$' THEN 'image/jpeg'
END
WHERE "content_type" IN ('', 'application/octet-stream')
	AND "filename" ~* '\.(pdf|eml|png|jpe?g)$';
