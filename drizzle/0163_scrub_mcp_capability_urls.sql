-- Upload links (and buyer reply file links) are their own credential, and
-- were kept whole in the MCP call log, which apps approved read only can
-- read. src/mcp/log.ts leaves their tokens out now; this takes them out of
-- what was already kept, by the same pattern (CAPABILITY_PATTERN in
-- src/auth/capability-urls.ts; src/mcp/log.test.ts keeps them equal).
--
-- The application still running while this migrates logs whole links, and
-- keeps doing so until the new one serves, so the database takes them out
-- of every row as it's written, by whichever code writes it. The trigger
-- comes first: a call logged meanwhile waits on its lock and is redacted,
-- and one logged before it is in what the scrub below sees.
CREATE OR REPLACE FUNCTION redact_mcp_call_capabilities() RETURNS trigger AS $$
BEGIN
  NEW.result := regexp_replace(NEW.result, '((?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])[a-z0-9-]+(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])po-file(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])damage(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])shared-files(?:/|%2[Ff])|token(?:=|%3[Dd]))[A-Za-z0-9_-]+', '\1[redacted]', 'g');
  NEW.arguments := regexp_replace(NEW.arguments::text, '((?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])[a-z0-9-]+(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])po-file(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])damage(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])shared-files(?:/|%2[Ff])|token(?:=|%3[Dd]))[A-Za-z0-9_-]+', '\1[redacted]', 'g')::jsonb;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER mcp_calls_redact_capabilities
  BEFORE INSERT OR UPDATE ON mcp_calls
  FOR EACH ROW EXECUTE FUNCTION redact_mcp_call_capabilities();
--> statement-breakpoint
UPDATE "mcp_calls"
SET "result" = regexp_replace("result", '((?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])[a-z0-9-]+(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])po-file(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])damage(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])shared-files(?:/|%2[Ff])|token(?:=|%3[Dd]))[A-Za-z0-9_-]+', '\1[redacted]', 'g')
WHERE "result" ~ '((?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])[a-z0-9-]+(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])po-file(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])damage(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])shared-files(?:/|%2[Ff])|token(?:=|%3[Dd]))[A-Za-z0-9_-]+';
--> statement-breakpoint
UPDATE "mcp_calls"
SET "arguments" = regexp_replace("arguments"::text, '((?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])[a-z0-9-]+(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])po-file(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])damage(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])shared-files(?:/|%2[Ff])|token(?:=|%3[Dd]))[A-Za-z0-9_-]+', '\1[redacted]', 'g')::jsonb
WHERE "arguments"::text ~ '((?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])[a-z0-9-]+(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])po-file(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])uploads(?:/|%2[Ff])damage(?:/|%2[Ff])|(?:/|%2[Ff])api(?:/|%2[Ff])shared-files(?:/|%2[Ff])|token(?:=|%3[Dd]))[A-Za-z0-9_-]+';
