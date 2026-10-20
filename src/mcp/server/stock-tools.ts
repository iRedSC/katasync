import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import {
	recordCount,
	requestCounts,
	transferStock,
	undoBatch,
} from "#/inventory/ledger";
import { PurchaseOrderError, purchaseOrderOfBatch } from "#/purchasing/orders";
import { ourLocation, productBySku } from "./lookups";
import { json, WRITE } from "./tool-shapes";

export function registerStockTools(server: McpServer, db: Db) {
	// Stock

	server.registerTool(
		"record_count",
		{
			description:
				"Records how many of a product are on the shelf. The difference from what katasync thinks is booked as an adjustment (returns its batch_id for undo_stock_change). Tool sets can't be counted; count their parts.",
			inputSchema: {
				sku: z.string(),
				counted: z.number().int(),
				reason: z.enum(["count", "damaged", "found", "other"]).default("count"),
				note: z.string().optional(),
				location: z
					.string()
					.optional()
					.describe("Needed only when there are several of our locations"),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, counted, reason, note, location }) => {
			const product = await productBySku(db, sku);
			const labels = {
				count: "Counted",
				damaged: "Damaged",
				found: "Found",
				other: "Other",
			};
			const result = await recordCount(db, {
				productId: product.id,
				locationId: await ourLocation(db, location),
				counted,
				note: [labels[reason], note?.trim(), "via Claude"]
					.filter(Boolean)
					.join(": "),
			});
			return json({ sku, ...result });
		},
	);

	server.registerTool(
		"request_counts",
		{
			description:
				"Puts shelves on the staff's cycle count list. Each stays there until someone counts it. Asking for one already on the list keeps it there. Tool sets can't be counted; ask for their parts. Returns how many shelves are now requested.",
			inputSchema: {
				skus: z.array(z.string()).min(1),
				location: z
					.string()
					.optional()
					.describe("Needed only when there are several of our locations"),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ skus, location }) => {
			const productIds = [];
			for (const sku of skus) productIds.push((await productBySku(db, sku)).id);
			await requestCounts(db, {
				productIds,
				locationId: await ourLocation(db, location),
			});
			return json({ requested: new Set(productIds).size });
		},
	);

	server.registerTool(
		"transfer_stock",
		{
			description:
				"Moves units of a product between our own locations, e.g. restocking the retail store from the warehouse. Refused when the location it leaves doesn't hold that many; ask for a count there instead. Returns its batch_id for undo_stock_change.",
			inputSchema: {
				sku: z.string(),
				quantity: z.number().int().positive(),
				from: z.string().describe("Location name the units leave"),
				to: z.string().describe("Location name the units go to"),
				note: z.string().optional(),
			},
			annotations: WRITE,
		},
		async ({ sku, quantity, from, to, note }) => {
			const product = await productBySku(db, sku);
			const { batchId } = await transferStock(db, {
				productId: product.id,
				fromLocationId: await ourLocation(db, from),
				toLocationId: await ourLocation(db, to),
				quantity,
				note: [note?.trim(), "via Claude"].filter(Boolean).join(": "),
			});
			return json({ sku, quantity, from, to, batch_id: batchId });
		},
	);

	server.registerTool(
		"undo_stock_change",
		{
			description:
				"Reverses a stock change (a ledger batch, e.g. from record_count) by posting its opposite. Receipts on a PO must be undone in the app.",
			inputSchema: { batch_id: z.string().uuid() },
			annotations: WRITE,
		},
		async ({ batch_id }) => {
			const po = await purchaseOrderOfBatch(db, batch_id);
			if (po !== null)
				throw new PurchaseOrderError(
					`This came in on PO ${po}. Undo it on the PO in the app.`,
				);
			return json(await undoBatch(db, batch_id));
		},
	);
}
