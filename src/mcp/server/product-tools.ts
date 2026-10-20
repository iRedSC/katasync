import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import { assembleKits, disassembleKits } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import {
	archiveProduct,
	deleteProduct,
	restoreProduct,
} from "#/products/archive";
import { updateProductDetails } from "#/products/details";
import { ownedLocation, productBySku } from "./lookups";
import { json, WRITE } from "./tool-shapes";

export function registerProductTools(server: McpServer, db: Db) {
	// Products and kits

	server.registerTool(
		"update_product",
		{
			description:
				"Changes a product's details. Only given fields change; null clears one. unit_cost is USD per single item (receiving POs averages it automatically). Weight in ounces and size in inches are what labels are bought with.",
			inputSchema: {
				sku: z.string(),
				name: z.string().optional(),
				variant_name: z
					.string()
					.nullable()
					.optional()
					.describe("Only for products in a group, e.g. 12 x 9 x 2"),
				category: z.string().nullable().optional(),
				barcode: z.string().nullable().optional(),
				unit_cost: z.number().min(0).nullable().optional(),
				weight_oz: z.number().positive().nullable().optional(),
				length_in: z.number().positive().nullable().optional(),
				width_in: z.number().positive().nullable().optional(),
				height_in: z.number().positive().nullable().optional(),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, ...input }) => {
			const product = await productBySku(db, sku);
			return json(
				await updateProductDetails(db, product.id, {
					name: input.name,
					variantName: input.variant_name,
					category: input.category,
					barcode: input.barcode,
					unitCost: input.unit_cost,
					weightOz: input.weight_oz,
					lengthIn: input.length_in,
					widthIn: input.width_in,
					heightIn: input.height_in,
				}),
			);
		},
	);

	server.registerTool(
		"set_components",
		{
			description:
				"Replaces what a kit (pre-assembled) or tool set (bundle) is made of. Kits hold simple products; tool sets hold simple products or kits.",
			inputSchema: {
				sku: z.string(),
				components: z
					.array(
						z.object({
							sku: z.string(),
							quantity: z.number().int().positive(),
						}),
					)
					.min(1),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, components }) => {
			const parent = await productBySku(db, sku);
			const parts = [];
			for (const c of components)
				parts.push({
					productId: (await productBySku(db, c.sku)).id,
					quantity: c.quantity,
				});
			await setRecipe(db, parent.id, parts);
			return json({ sku, components });
		},
	);

	server.registerTool(
		"archive_product",
		{
			description:
				"Archives a product no longer carried: it leaves product lists, pickers, reordering, counting, and listing matching, and its history stays. Refused, saying what to settle first, while a live listing sells it, any is on our shelves, an active kit or tool set holds it, or an open PO has it. restore_product undoes it.",
			inputSchema: { sku: z.string() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku }) => json(await archiveProduct(db, sku)),
	);

	server.registerTool(
		"restore_product",
		{
			description: "Carries an archived product again.",
			inputSchema: { sku: z.string() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku }) => json(await restoreProduct(db, sku)),
	);

	server.registerTool(
		"delete_product",
		{
			description:
				"Deletes a product that has no history (e.g. made by mistake), with its parts list, aliases, and supplier terms. Can't be undone. Refused, saying why, when it ever sold, moved stock, was counted, was on a PO, is a part of a kit or tool set, or listings sell it: archive it instead. Ask the user first.",
			inputSchema: { sku: z.string() },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ sku }) => json(await deleteProduct(db, sku)),
	);

	for (const [name, direction] of [
		["assemble_kits", "assemble"],
		["disassemble_kits", "disassemble"],
	] as const)
		server.registerTool(
			name,
			{
				description:
					direction === "assemble"
						? "Builds kits from their parts on the shelf: the parts' stock goes down and the kit's goes up. Fails, changing nothing, if a part would go below zero. Returns a batch_id for undo_stock_change."
						: "Takes kits apart back into their parts, e.g. to free a part for an order. Returns a batch_id for undo_stock_change.",
				inputSchema: {
					sku: z.string().describe("The kit"),
					quantity: z.number().int().positive(),
					location: z
						.string()
						.optional()
						.describe("Needed only when there are several of our locations"),
				},
				annotations: WRITE,
			},
			async ({ sku, quantity, location }) => {
				const kit = await productBySku(db, sku);
				const input = {
					kitProductId: kit.id,
					quantity,
					locationId: await ownedLocation(db, location),
					reference: "via Claude",
				};
				return json(
					direction === "assemble"
						? await assembleKits(db, input)
						: await disassembleKits(db, input),
				);
			},
		);
}
