-- 0041 made purchase_order_amendments without letting the MCP query role
-- read it (see 0027_mcp_role.sql). A fresh migration rather than an edit to
-- 0041, which databases have already run.
GRANT SELECT ON "purchase_order_amendments" TO katasync_mcp;
