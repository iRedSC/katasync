import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { packages, products } from "#/db/schema";
import { matchListing, productFromListing } from "#/orders/remap";
import { PurchaseOrderError } from "#/purchasing/orders";
import { createBoxes, updateBox } from "#/shipping/boxes";
import { productBySku } from "./lookups";
import { boxShape, json, WRITE } from "./tool-shapes";

export function registerCatalogTools(server: McpServer, db: Db) {
	server.registerTool(
		"create_boxes",
		{
			description:
				"Adds shipping boxes for quick ship, all or none. Sizes in inches, empty weight in ounces. A pin is 1 to 999; left out, the lowest free pin is used.",
			inputSchema: {
				boxes: z
					.array(
						z.object({
							pin: z.number().int().min(1).max(999).optional(),
							...boxShape,
						}),
					)
					.min(1),
			},
			annotations: WRITE,
		},
		async ({ boxes }) => {
			const saved = await createBoxes(
				db,
				boxes.map((b) => ({
					name: b.name ?? `${b.length_in} × ${b.width_in} × ${b.height_in}`,
					lengthIn: b.length_in,
					widthIn: b.width_in,
					heightIn: b.height_in,
					weightOz: b.weight_oz,
					pin: b.pin,
				})),
			);
			return json(saved.map((b) => ({ pin: b.pin, name: b.name })));
		},
	);

	server.registerTool(
		"update_box",
		{
			description:
				"Changes a shipping box, found by its pin. Only given fields change; new_pin moves it to another pin.",
			inputSchema: {
				pin: z.number().int().min(1).max(999),
				new_pin: z.number().int().min(1).max(999).optional(),
				...z.object(boxShape).partial().shape,
			},
			annotations: WRITE,
		},
		async (input) => {
			const [box] = await db
				.select()
				.from(packages)
				.where(eq(packages.pin, input.pin));
			if (!box) throw new PurchaseOrderError(`No box with pin ${input.pin}`);
			const inches = (mm: number) => mm / 25.4;
			const saved = await updateBox(db, box.id, {
				name: input.name ?? box.name,
				lengthIn: input.length_in ?? inches(box.lengthMm),
				widthIn: input.width_in ?? inches(box.widthMm),
				heightIn: input.height_in ?? inches(box.heightMm),
				weightOz: input.weight_oz ?? box.weightGrams / 28.349523125,
				pin: input.new_pin ?? box.pin,
			});
			return json({ pin: saved.pin, name: saved.name });
		},
	);

	server.registerTool(
		"match_listing",
		{
			description:
				"Resolves one unmatched item: matches all its listing_ids (from unmatched_listings) to the product with sku, all or none, then lets past orders take their stock. Without sku, makes a new product from the listings instead, using new_sku (required when the listings have no SKU) and new_name (defaults to the title). Refused if any listing was matched since.",
			inputSchema: {
				listing_ids: z.array(z.number().int().positive()).min(1),
				sku: z.string().optional(),
				new_sku: z.string().optional(),
				new_name: z.string().optional(),
			},
			annotations: WRITE,
		},
		async ({ listing_ids, sku, new_sku, new_name }) => {
			if (sku && (new_sku || new_name))
				throw new PurchaseOrderError(
					"Give sku to match, or new_sku/new_name to create, not both",
				);
			return json(
				sku
					? await matchListing(db, listing_ids, sku)
					: await productFromListing(db, listing_ids, {
							sku: new_sku,
							name: new_name,
						}),
			);
		},
	);

	server.registerTool(
		"set_insure_when_shipped",
		{
			description:
				"Whether quick ship always offers insurance for orders holding this product.",
			inputSchema: { sku: z.string(), insure: z.boolean() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, insure }) => {
			const product = await productBySku(db, sku);
			await db
				.update(products)
				.set({ insureWhenShipped: insure })
				.where(eq(products.id, product.id));
			return json({ sku, insure });
		},
	);
}
