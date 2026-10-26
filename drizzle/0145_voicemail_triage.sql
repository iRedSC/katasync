ALTER TABLE "market_emails" ADD COLUMN "voicemail" jsonb;--> statement-breakpoint
ALTER TABLE "market_emails" ADD CONSTRAINT "market_emails_voicemail_state" CHECK ("market_emails"."voicemail" is null or coalesce(
			jsonb_typeof("market_emails"."voicemail") = 'object' and case "market_emails"."voicemail"->>'state'
				when 'pending' then true
				when 'processing' then jsonb_typeof("market_emails"."voicemail"->'token') = 'string' and jsonb_typeof("market_emails"."voicemail"->'startedAt') = 'string'
				when 'ready' then length("market_emails"."voicemail"->>'title') > 0 and length("market_emails"."voicemail"->>'summary') > 0 and "market_emails"."voicemail"->>'level' in ('normal', 'important', 'critical') and jsonb_typeof("market_emails"."voicemail"->'orderIds') = 'array' and jsonb_typeof("market_emails"."voicemail"->'productIds') = 'array'
				when 'review' then length("market_emails"."voicemail"->>'reason') > 0
				when 'dismissed' then length("market_emails"."voicemail"->>'reason') > 0
				else false end, false));--> statement-breakpoint
UPDATE "market_emails"
SET "voicemail" = '{"state":"pending"}'::jsonb,
    "relabelled_at" = coalesce("relabelled_at", now())
WHERE lower(trim("from_address")) = 'no_reply@ooma.com'
  AND "subject" ~* '\mnew voicemail\M';
