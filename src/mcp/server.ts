import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db } from "#/db/client";
import { registerCatalogTools } from "./server/catalog-tools";
import { INSTRUCTIONS } from "./server/instructions";
import { registerProductTools } from "./server/product-tools";
import { registerPurchasingTools } from "./server/purchasing-tools";
import { registerReadTools } from "./server/read-tools";
import { registerReceivingTools } from "./server/receiving-tools";
import { registerStockTools } from "./server/stock-tools";
import { registerSupplierTools } from "./server/supplier-tools";

// katasync as MCP tools: read anything, change the catalog, draft POs, check
// supplier invoices, and count stock. Emailing POs, buying labels, and
// anything else that reaches suppliers, carriers, or money stays in the app;
// mark_po_sent only records a PO the supplier already has. Server only.

// Tools that only read. /mcp logs calls to every other tool, so a new write
// tool is logged even if this list isn't updated.
export const READ_TOOLS = new Set([
	"describe_schema",
	"query",
	"sync_status",
	"counts_due",
	"reorder_suggestions",
	"get_purchase_order",
	"list_purchase_units",
	"match_invoice",
	"unmatched_listings",
	"suggest_matches",
]);

export function buildServer(db: Db, access: { canWrite: boolean }) {
	const server = new McpServer(
		{ name: "katasync", version: "1.0.0" },
		{ instructions: INSTRUCTIONS },
	);

	registerReadTools(server, db);
	if (access.canWrite) registerWriteTools(server, db);
	return server;
}

// Tools that change things. Only apps approved to make changes get them, and
// src/routes/mcp.ts logs every call to them.
function registerWriteTools(server: McpServer, db: Db) {
	registerPurchasingTools(server, db);
	registerSupplierTools(server, db);
	registerCatalogTools(server, db);
	registerStockTools(server, db);
	registerProductTools(server, db);
	registerReceivingTools(server, db);
}
