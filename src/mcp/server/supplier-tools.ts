import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { products, supplierOffers } from "#/db/schema";
import {
	catalogsOf,
	deleteCatalog,
	describeCatalog,
	ensureCatalog,
	renameCatalog,
	setCarried,
	setProductsCatalog,
} from "#/purchasing/catalogs";
import {
	fillSupplierSkus,
	setSupplierTerms,
	supplierByRef,
	updateSupplier,
} from "#/purchasing/suppliers";
import {
	addUnit,
	deleteUnit,
	renameUnit,
	setPurchaseUnit,
} from "#/purchasing/units";
import { catalogByName, productBySku } from "./lookups";
import { json, unitTerms, WRITE } from "./tool-shapes";

export function registerSupplierTools(server: McpServer, db: Db) {
	// Catalog and setup

	server.registerTool(
		"set_product_catalog",
		{
			description:
				"Puts products in a catalog by name, making the catalog if there isn't one; null takes them out of any. A product is in one catalog at most. Suppliers' terms for a product are kept when it moves, so moving it back restores them. Up to 500 SKUs.",
			inputSchema: {
				skus: z.array(z.string()).min(1).max(500),
				catalog: z.string().nullable(),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ skus, catalog }) => {
			const found = await db
				.select({ id: products.id, sku: products.sku })
				.from(products)
				.where(
					inArray(
						products.sku,
						skus.map((s) => s.trim()),
					),
				);
			const missing = skus.filter(
				(s) => !found.some((p) => p.sku === s.trim()),
			);
			const catalogId =
				catalog === null ? null : await ensureCatalog(db, catalog);
			const before = await setProductsCatalog(
				db,
				found.map((p) => p.id),
				catalogId,
			);
			return json({
				catalog,
				moved: before.filter((b) => b.catalogId !== catalogId).length,
				alreadyThere: before.filter((b) => b.catalogId === catalogId).length,
				missing,
			});
		},
	);

	server.registerTool(
		"rename_catalog",
		{
			description: "Renames a catalog.",
			inputSchema: { catalog: z.string(), to: z.string() },
			annotations: WRITE,
		},
		async ({ catalog, to }) => {
			await renameCatalog(db, await catalogByName(db, catalog), to);
			return json({ renamed: catalog, to });
		},
	);

	server.registerTool(
		"describe_catalog",
		{
			description:
				'Sets what a catalog is about, e.g. "Taping tools, banjos"; searches for catalogs match it. Null clears it. Returns the description before.',
			inputSchema: { catalog: z.string(), description: z.string().nullable() },
			annotations: WRITE,
		},
		async ({ catalog, description }) => {
			const was = await describeCatalog(
				db,
				await catalogByName(db, catalog),
				description,
			);
			return json({ catalog, description, was });
		},
	);

	server.registerTool(
		"delete_catalog",
		{
			description:
				"Removes an empty catalog. One with products refuses: move them first with set_product_catalog.",
			inputSchema: { catalog: z.string() },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ catalog }) => {
			await deleteCatalog(db, await catalogByName(db, catalog));
			return json({ deleted: catalog });
		},
	);

	server.registerTool(
		"set_supplier_catalogs",
		{
			description:
				"Starts or stops a supplier carrying catalogs. Carrying one means it sells every product in it. Its terms for those products are kept when it stops, so carrying it again restores them. Catalogs to add are made if missing.",
			inputSchema: {
				supplier: z.string().describe("Code or name"),
				add: z.array(z.string()).default([]),
				remove: z.array(z.string()).default([]),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ supplier, add, remove }) => {
			const { id } = await supplierByRef(db, supplier);
			for (const name of add)
				await setCarried(db, {
					supplierId: id,
					catalogId: await ensureCatalog(db, name),
					carried: true,
				});
			for (const name of remove)
				await setCarried(db, {
					supplierId: id,
					catalogId: await catalogByName(db, name),
					carried: false,
				});
			return json({ supplier, carries: await catalogsOf(db, id) });
		},
	);

	server.registerTool(
		"set_supplier_terms",
		{
			description:
				"Sets a supplier's part number and price per purchase unit for a product it sells (the supplier must carry the product's catalog). Omitted fields keep their value. Each supplier has its own terms; reorder buys from the one with the lowest price per single item.",
			inputSchema: {
				sku: z.string(),
				supplier: z.string().describe("Code or name"),
				supplier_sku: z.string().nullable().optional(),
				cost: z.number().min(0).nullable().optional(),
			},
			annotations: WRITE,
		},
		async ({ sku, supplier, supplier_sku, cost }) => {
			const product = await productBySku(db, sku);
			const { id } = await supplierByRef(db, supplier);
			await setSupplierTerms(db, {
				productId: product.id,
				supplierId: id,
				...(supplier_sku !== undefined ? { supplierSku: supplier_sku } : {}),
				...(cost !== undefined ? { cost } : {}),
			});
			const offers = await db
				.select({
					supplierId: supplierOffers.supplierId,
					supplierSku: supplierOffers.supplierSku,
					unit: supplierOffers.unit,
					packSize: supplierOffers.packSize,
					cost: supplierOffers.cost,
					minimumQuantity: supplierOffers.minimumQuantity,
					cheapest: supplierOffers.cheapest,
				})
				.from(supplierOffers)
				.where(eq(supplierOffers.productId, product.id));
			return json({ sku, offers });
		},
	);

	server.registerTool(
		"set_supplier_skus",
		{
			description:
				"Fills in a supplier's item numbers for many products at once, e.g. supplierSkusToSave from match_invoice. Only products that supplier sells (in catalogs it carries) change. One that already has a different number keeps it unless replace is true. Reports filled, unchanged, kept, and skipped. Up to 200 per call.",
			inputSchema: {
				supplier: z.string().describe("Code or name"),
				items: z
					.array(z.object({ sku: z.string(), supplier_sku: z.string() }))
					.min(1)
					.max(200),
				replace: z.boolean().default(false),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ supplier, items, replace }) => {
			const { id } = await supplierByRef(db, supplier);
			// One lookup for all the SKUs. A database error fails the call here,
			// rather than reading as a SKU that isn't there.
			const found = await db
				.select({ id: products.id, sku: products.sku })
				.from(products)
				.where(
					inArray(
						products.sku,
						items.map((item) => item.sku.trim()),
					),
				);
			const bySku = new Map(found.map((p) => [p.sku, p]));
			const entries = [];
			const skipped = [];
			const listed = new Set<string>();
			for (const item of items) {
				const sku = item.sku.trim();
				const product = bySku.get(sku);
				if (!product) skipped.push({ sku: item.sku, reason: "no such SKU" });
				else if (listed.has(sku))
					skipped.push({ sku: item.sku, reason: "listed more than once" });
				else {
					listed.add(sku);
					entries.push({
						productId: product.id,
						sku: product.sku,
						supplierSku: item.supplier_sku,
					});
				}
			}
			const result = await fillSupplierSkus(db, {
				supplierId: id,
				entries,
				replace,
			});
			return json({ ...result, skipped: [...skipped, ...result.skipped] });
		},
	);

	server.registerTool(
		"set_purchase_unit",
		{
			description:
				"Sets the unit, pack size, and minimum a supplier sells a product in. That supplier's price converts to the new size, and its draft lines still on the old default follow.",
			inputSchema: {
				sku: z.string(),
				supplier: z.string().describe("Code or name"),
				...unitTerms,
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({
			sku,
			supplier,
			unit,
			pack_size,
			supplier_count = pack_size,
			minimum,
		}) => {
			const product = await productBySku(db, sku);
			await setPurchaseUnit(db, {
				productId: product.id,
				supplierId: (await supplierByRef(db, supplier)).id,
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
		"delete_purchase_unit",
		{
			description:
				"Removes a purchase unit no product is bought in. EACH stays.",
			inputSchema: { name: z.string() },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ name }) => {
			await deleteUnit(db, name.toUpperCase());
			return json({ deleted: name.toUpperCase() });
		},
	);

	server.registerTool(
		"update_supplier",
		{
			description:
				"Changes a supplier's details. Only given fields change. lead_time_days: days from sending a PO to delivery. cover_days: days of sales each PO should cover. minimum_order: spend (USD) at which a suggested PO counts as ready. critical_threshold: how many essential products (marked essential, A items, or parts some tool set can't be built without) needing ordering make it ready whatever the spend; twice as many make it Order soon.",
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
