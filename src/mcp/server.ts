import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db } from "#/db/client";
import { registerActionTools } from "./server/action-tools";
import { registerBuyerWriteTools } from "./server/buyer-tools";
import { registerCatalogTools } from "./server/catalog-tools";
import { registerFileReadTools, registerFileTools } from "./server/file-tools";
import {
	registerInboxReadTools,
	registerInboxWriteTools,
} from "./server/inbox-tools";
import { INSTRUCTIONS } from "./server/instructions";
import { registerListingTools } from "./server/listing-tools";
import {
	registerMailRuleReadTools,
	registerMailRuleWriteTools,
} from "./server/mail-rule-tools";
import { registerMarketTools } from "./server/market-tools";
import { registerProductTools } from "./server/product-tools";
import { registerPurchasingTools } from "./server/purchasing-tools";
import { registerReadTools } from "./server/read-tools";
import { registerReceivingTools } from "./server/receiving-tools";
import { registerStockSettingsTools } from "./server/stock-settings-tools";
import { registerStockTools } from "./server/stock-tools";
import { registerSupplierTools } from "./server/supplier-tools";
import {
	registerTransferReadTools,
	registerTransferTools,
} from "./server/transfer-tools";

// katasync as MCP tools: read anything, change the catalog, draft, close,
// and cancel POs, check supplier invoices, read the purchasing inbox, count and transfer stock, receive
// returns, switch stock push, and sync. Emailing POs, buying labels, and
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
	"refill_suggestions",
	"get_transfer",
	"po_emails",
	"read_po_email",
	"read_po_file",
	"search_inbox",
	"read_inbox_email",
	"markets",
	"search_marketplace_mail",
	"read_marketplace_email",
	"mail_rules",
]);

export function buildServer(db: Db, access: { canWrite: boolean }) {
	const server = new McpServer(
		{ name: "katasync", version: "1.0.0" },
		{ instructions: INSTRUCTIONS },
	);

	registerReadTools(server, db);
	registerTransferReadTools(server, db);
	registerInboxReadTools(server, db);
	registerFileReadTools(server, db);
	registerMarketTools(server, db);
	registerMailRuleReadTools(server, db);
	if (access.canWrite) registerWriteTools(server, db);
	return server;
}

// Tools that change things. Only apps approved to make changes get them, and
// src/routes/mcp.ts logs every call to them.
function registerWriteTools(server: McpServer, db: Db) {
	registerPurchasingTools(server, db);
	registerSupplierTools(server, db);
	registerCatalogTools(server, db);
	registerListingTools(server, db);
	registerStockTools(server, db);
	registerStockSettingsTools(server, db);
	registerTransferTools(server, db);
	registerActionTools(server, db);
	registerProductTools(server, db);
	registerReceivingTools(server, db);
	registerFileTools(server, db);
	registerInboxWriteTools(server, db);
	registerMailRuleWriteTools(server, db);
	registerBuyerWriteTools(server, db);
}
