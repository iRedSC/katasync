-- Upload links (and buyer reply file links) are their own credential, and
-- were kept whole in the MCP call log, which apps approved read only can
-- read. src/mcp/log.ts leaves their tokens out now; this takes them out of
-- what was already kept, by the same pattern (src/auth/capability-urls.ts).
UPDATE "mcp_calls"
SET "result" = regexp_replace("result", '(/api/uploads/[a-z0-9-]+/|/api/shared-files/|/setup\?token=)[A-Za-z0-9_-]+', '\1[redacted]', 'g')
WHERE "result" ~ '(/api/uploads/[a-z0-9-]+/|/api/shared-files/|/setup\?token=)[A-Za-z0-9_-]';
--> statement-breakpoint
UPDATE "mcp_calls"
SET "arguments" = regexp_replace("arguments"::text, '(/api/uploads/[a-z0-9-]+/|/api/shared-files/|/setup\?token=)[A-Za-z0-9_-]+', '\1[redacted]', 'g')::jsonb
WHERE "arguments"::text ~ '(/api/uploads/[a-z0-9-]+/|/api/shared-files/|/setup\?token=)[A-Za-z0-9_-]';
