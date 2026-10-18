-- 0061 made these without letting /mcp read them; every other table does
-- (src/mcp/query.ts lists the few that stay secret).
GRANT SELECT ON "return_requests", "return_request_lines", "order_returns_due" TO katasync_mcp;
