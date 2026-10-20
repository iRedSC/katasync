import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { products } from "#/db/schema";
import {
	setDefaultMinStock,
	setProductStockRange,
} from "#/inventory/stock-range";
import { changeRetailReserve } from "#/stock-push/reserve";
import { productBySku } from "./lookups";
import { json, WRITE } from "./tool-shapes";

// The settings behind stock ranges, overflow, and what counts as essential,
// as the app's Settings and product pages change them.
export function registerStockSettingsTools(server: McpServer, db: Db) {
	server.registerTool(
		"set_retail_reserve",
		{
			description:
				"How many of each product the retail store keeps for walk-ins. When the warehouse is out, shipped orders take from the store only what it holds above this, and the channels offer only that much: with 2, the store needs 3 or more before online can take one. 0 lets online take everything there. Pushes the change to the channels.",
			inputSchema: { units: z.number().int().min(0) },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ units }) => {
			await changeRetailReserve(db, units);
			return json({ retail_reserve: units });
		},
	);

	server.registerTool(
		"set_default_min_stock",
		{
			description:
				"The min stock for products without their own range. Their max comes from their sales forecast.",
			inputSchema: { min: z.number().int().min(0) },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ min }) => {
			await setDefaultMinStock(db, min);
			return json({ default_min_stock: min });
		},
	);

	server.registerTool(
		"set_stock_range",
		{
			description:
				"A product's own stock range (min and max on hand), which reorder suggestions aim for. Max must be more than min. Pass range null to put it back on the defaults.",
			inputSchema: {
				sku: z.string(),
				range: z
					.object({ min: z.number().int().min(0), max: z.number().int() })
					.nullable(),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, range }) => {
			const product = await productBySku(db, sku);
			await setProductStockRange(db, product.id, range);
			return json({ sku, range });
		},
	);

	server.registerTool(
		"set_critical",
		{
			description:
				"Whether a product is essential: it counts toward a supplier's critical threshold, so needing it can make a suggested PO ready whatever the spend.",
			inputSchema: { sku: z.string(), critical: z.boolean() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, critical }) => {
			const product = await productBySku(db, sku);
			await db
				.update(products)
				.set({ critical })
				.where(eq(products.id, product.id));
			return json({ sku, critical });
		},
	);
}
