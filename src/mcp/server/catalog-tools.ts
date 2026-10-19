import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { packages, products } from "#/db/schema";
import { matchListing, productFromListing } from "#/orders/remap";
import { PurchaseOrderError } from "#/purchasing/orders";
import { boxLabel } from "#/shipping/box-filter";
import { createBoxes, updateBox } from "#/shipping/boxes";
import { productBySku } from "./lookups";
import { boxShape, json, WRITE } from "./tool-shapes";

export function registerCatalogTools(server: McpServer, db: Db) {
	server.registerTool(
		"create_boxes",
		{
			description:
				"Adds shipping boxes for quick ship, all or none. Sizes in inches, empty weight in ounces. Quick ship finds boxes by size, so name one only when the size alone doesn't say which box it is.",
			inputSchema: { boxes: z.array(z.object(boxShape)).min(1) },
			annotations: WRITE,
		},
		async ({ boxes }) => {
			const saved = await createBoxes(
				db,
				boxes.map((b) => ({
					name: b.name,
					lengthIn: b.length_in,
					widthIn: b.width_in,
					heightIn: b.height_in,
					weightOz: b.weight_oz,
				})),
			);
			return json(saved.map((b) => ({ id: b.id, box: boxLabel(b) })));
		},
	);

	server.registerTool(
		"update_box",
		{
			description:
				"Changes a shipping box, found by its id (the packages table). Only given fields change; a name of null or empty clears it.",
			inputSchema: {
				id: z.number().int().positive(),
				...z.object(boxShape).partial().shape,
				name: z.string().nullable().optional(),
			},
			annotations: WRITE,
		},
		async (input) => {
			const [box] = await db
				.select()
				.from(packages)
				.where(eq(packages.id, input.id));
			if (!box) throw new PurchaseOrderError(`No box with id ${input.id}`);
			const inches = (mm: number) => mm / 25.4;
			const saved = await updateBox(db, box.id, {
				name: input.name === undefined ? box.name : input.name,
				lengthIn: input.length_in ?? inches(box.lengthMm),
				widthIn: input.width_in ?? inches(box.widthMm),
				heightIn: input.height_in ?? inches(box.heightMm),
				weightOz: input.weight_oz ?? box.weightGrams / 28.349523125,
			});
			return json({ id: saved.id, box: boxLabel(saved) });
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

	server.registerTool(
		"set_aerosol",
		{
			description:
				"Whether this product is an aerosol: quick ship then marks its boxes hazmat (ground services only, Limited Quantity mark printed).",
			inputSchema: { sku: z.string(), aerosol: z.boolean() },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, aerosol }) => {
			const product = await productBySku(db, sku);
			await db
				.update(products)
				.set({ aerosol })
				.where(eq(products.id, product.id));
			return json({ sku, aerosol });
		},
	);
}
