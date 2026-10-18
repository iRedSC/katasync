import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { productSuppliers } from "#/db/schema";
import {
	fillSupplierSkus,
	setProductSupplier,
	supplierByRef,
	updateSupplier,
} from "#/purchasing/suppliers";
import { addUnit, renameUnit, setPurchaseUnit } from "#/purchasing/units";
import { productBySku } from "./lookups";
import { json, unitTerms, WRITE } from "./tool-shapes";

export function registerSupplierTools(server: McpServer, db: Db) {
	// Catalog and setup

	server.registerTool(
		"set_product_supplier",
		{
			description:
				"Sets who a product is bought from, their part number, and their price per purchase unit. supplier null removes it. Omitted fields keep their value.",
			inputSchema: {
				sku: z.string(),
				supplier: z.string().nullable().describe("Code or name; null removes"),
				supplier_sku: z.string().nullable().optional(),
				cost: z.number().min(0).nullable().optional(),
			},
			annotations: WRITE,
		},
		async ({ sku, supplier, supplier_sku, cost }) => {
			const product = await productBySku(db, sku);
			await setProductSupplier(db, {
				productId: product.id,
				supplierId:
					supplier === null ? null : (await supplierByRef(db, supplier)).id,
				...(supplier_sku !== undefined ? { supplierSku: supplier_sku } : {}),
				...(cost !== undefined ? { cost } : {}),
			});
			const [link] = await db
				.select()
				.from(productSuppliers)
				.where(eq(productSuppliers.productId, product.id));
			return json(link ?? { sku, supplier: null });
		},
	);

	server.registerTool(
		"set_supplier_skus",
		{
			description:
				"Fills in a supplier's item numbers for many products at once, e.g. supplierSkusToSave from match_invoice. Only products bought from that supplier change. One that already has a different number keeps it unless replace is true. Reports filled, unchanged, kept, and skipped.",
			inputSchema: {
				supplier: z.string().describe("Code or name"),
				items: z
					.array(z.object({ sku: z.string(), supplier_sku: z.string() }))
					.min(1),
				replace: z.boolean().default(false),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ supplier, items, replace }) => {
			const { id } = await supplierByRef(db, supplier);
			const entries = [];
			const unknown = [];
			for (const item of items) {
				const product = await productBySku(db, item.sku).catch(() => null);
				if (!product) unknown.push({ sku: item.sku, reason: "no such SKU" });
				else
					entries.push({
						productId: product.id,
						sku: product.sku,
						supplierSku: item.supplier_sku,
					});
			}
			const result = await fillSupplierSkus(db, {
				supplierId: id,
				entries,
				replace,
			});
			return json({ ...result, skipped: [...unknown, ...result.skipped] });
		},
	);

	server.registerTool(
		"set_purchase_unit",
		{
			description:
				"Sets the default unit, pack size, and minimum a product is bought in. Its supplier price converts to the new size, and draft lines still on the old default follow.",
			inputSchema: { sku: z.string(), ...unitTerms },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, unit, pack_size, supplier_count = pack_size, minimum }) => {
			const product = await productBySku(db, sku);
			await setPurchaseUnit(db, {
				productId: product.id,
				unit: unit.toUpperCase(),
				packSize: pack_size,
				supplierCount: supplier_count,
				minimumQuantity: minimum,
			});
			return json({
				sku,
				unit: unit.toUpperCase(),
				pack_size,
				supplier_count,
				minimum,
			});
		},
	);

	server.registerTool(
		"add_purchase_unit",
		{
			description: "Adds a unit products can be bought in, e.g. ROLL.",
			inputSchema: { name: z.string() },
			annotations: WRITE,
		},
		async ({ name }) => json({ added: await addUnit(db, name) }),
	);

	server.registerTool(
		"rename_purchase_unit",
		{
			description:
				"Renames a purchase unit everywhere it's used, including drafts. Sent POs keep the old name.",
			inputSchema: { from: z.string(), to: z.string() },
			annotations: WRITE,
		},
		async ({ from, to }) =>
			json({ renamed: await renameUnit(db, from.toUpperCase(), to) }),
	);

	server.registerTool(
		"update_supplier",
		{
			description:
				"Changes a supplier's details. Only given fields change. lead_time_days: days from sending a PO to delivery. cover_days: days of sales each PO should cover. minimum_order: spend (USD) at which a suggested PO counts as ready. critical_threshold: how many essential products (marked essential, A items, or parts some tool set can't be built without) needing ordering make it ready whatever the spend.",
			inputSchema: {
				supplier: z.string().describe("Code or name"),
				name: z.string().optional(),
				contact_name: z.string().nullable().optional(),
				email: z.string().email().nullable().optional(),
				phone: z.string().nullable().optional(),
				address1: z.string().nullable().optional(),
				address2: z.string().nullable().optional(),
				city: z.string().nullable().optional(),
				region: z.string().nullable().optional().describe("State or province"),
				postal_code: z.string().nullable().optional(),
				country: z
					.string()
					.nullable()
					.optional()
					.describe("Two-letter code, e.g. US"),
				payment_terms: z.string().nullable().optional(),
				notes: z.string().nullable().optional().describe("For us only"),
				po_notes: z
					.string()
					.nullable()
					.optional()
					.describe("Printed on every PO"),
				lead_time_days: z.number().int().min(1).max(365).optional(),
				cover_days: z.number().int().min(1).max(365).optional(),
				minimum_order: z.number().min(0).optional(),
				critical_threshold: z.number().int().min(1).optional(),
			},
			annotations: WRITE,
		},
		async (input) => {
			const { id } = await supplierByRef(db, input.supplier);
			await updateSupplier(db, id, {
				name: input.name,
				contactName: input.contact_name,
				email: input.email,
				phone: input.phone,
				address1: input.address1,
				address2: input.address2,
				city: input.city,
				region: input.region,
				postalCode: input.postal_code,
				country: input.country,
				paymentTerms: input.payment_terms,
				notes: input.notes,
				poNotes: input.po_notes,
				leadTimeDays: input.lead_time_days,
				coverDays: input.cover_days,
				minimumOrder: input.minimum_order,
				criticalThreshold: input.critical_threshold,
			});
			return json({ updated: input.supplier });
		},
	);
}
