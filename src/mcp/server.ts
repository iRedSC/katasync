import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { shippingLocation } from "#/channels/stores";
import type { Db } from "#/db/client";
import {
	listings,
	locations,
	packages,
	productSuppliers,
	products,
	purchaseOrderLines,
} from "#/db/schema";
import { type CheckTarget, runCheck } from "#/diagnostics/checks";
import { diagnosticsOverview } from "#/diagnostics/overview";
import {
	assembleKits,
	disassembleKits,
	recordCount,
	requestCounts,
	undoBatch,
} from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { matchListing, productFromListing } from "#/orders/remap";
import { updateProductDetails } from "#/products/details";
import { loadOrder } from "#/purchasing/load";
import {
	cancelOrder,
	draftFromSuggestions,
	openDraft,
	PurchaseOrderError,
	purchaseOrderOfBatch,
	receive,
	setDraftLine,
	undoReceipt,
	updateDraft,
} from "#/purchasing/orders";
import { suggestPurchases } from "#/purchasing/reorder";
import {
	setProductSupplier,
	supplierByRef,
	updateSupplier,
} from "#/purchasing/suppliers";
import {
	addUnit,
	listUnits,
	renameUnit,
	setLineTerms,
	setPurchaseUnit,
} from "#/purchasing/units";
import { createBoxes, updateBox } from "#/shipping/boxes";
import { describeSchema, MAX_ROWS, readOnlyQuery } from "./query";

// katasync as MCP tools: read anything, change the catalog, draft POs, and
// count stock. Sending POs, buying labels, and anything else that reaches
// suppliers, carriers, or money stays in the app. Server only.

const INSTRUCTIONS = `katasync runs inventory, purchasing, and order sync for East Coast Drywall Tools, selling on Shopify (which also relays TikTok Shop), Amazon, and eBay.

How things count:
- Products are identified by SKU. Kinds: simple, kit (pre-assembled, own stock), bundle (a "tool set": no stock of its own, sold as its parts).
- Stock: use the owned_stock view (product_id, sku, on_hand). It leaves out Amazon's FBA stock, which isn't ours to ship. Negative means oversold.
- Sales: use the sales_units view (product_id, order_id, store_id, placed_at, units). Tool sets count as their parts; cancelled and FBA orders are left out. Join stores for the channel.
- Order history doesn't start at the same time on every channel. Before saying something "hasn't sold in N days", check min(placed_at) per store and say how far back each channel goes.
- Each product has one supplier (product_suppliers), bought in a unit with a pack size and minimum, e.g. CASE of 12, min 2. PO quantities and prices are per that unit; stock counts single items.
- POs: draft, sent, closed, cancelled. Each supplier has at most one draft; tools that add lines put them on it, creating it if needed. Nothing here sends a PO: the user reviews and sends drafts in the app. Sent POs can be received here.
- Cycle counts only happen when asked for: request_counts puts shelves on the staff's count list, and a count clears them. Ask when stock looks wrong, e.g. oversold or not matching what a channel reports.
- Stock and receiving changes can be undone (undo_stock_change, undo_po_receipt). Every change you make is logged and shown to the user.

Use describe_schema before writing SQL. Prefer reorder_suggestions for "what should we order": it accounts for lead time, what's already on order, and minimums. When a request is ambiguous about quantities, say which interpretation you used.`;

// Tools that only read. /mcp logs calls to every other tool, so a new write
// tool is logged even if this list isn't updated.
export const READ_TOOLS = new Set([
	"describe_schema",
	"query",
	"sync_status",
	"reorder_suggestions",
	"get_purchase_order",
	"list_purchase_units",
]);

const json = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
});

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	openWorldHint: false,
} as const;

async function productBySku(db: Db, sku: string) {
	const [product] = await db
		.select({ id: products.id, sku: products.sku, kind: products.kind })
		.from(products)
		.where(eq(products.sku, sku.trim()));
	if (!product) throw new PurchaseOrderError(`No product with SKU ${sku}`);
	return product;
}

async function ownedLocation(db: Db, name?: string) {
	if (name) {
		const [found] = await db
			.select({ id: locations.id, kind: locations.kind })
			.from(locations)
			.where(eq(locations.name, name));
		if (found?.kind !== "owned")
			throw new PurchaseOrderError(`No location of ours called ${name}`);
		return found.id;
	}
	const only = await shippingLocation(db);
	if (only === null)
		throw new PurchaseOrderError("There are several locations; name one");
	return only;
}

const unitTerms = {
	unit: z.string().describe("Purchase unit name, e.g. EACH or CASE"),
	pack_size: z
		.number()
		.int()
		.positive()
		.describe("How many of the product one unit holds; 1 for EACH"),
	minimum: z
		.number()
		.int()
		.positive()
		.describe("Fewest units the supplier sells"),
};

const boxShape = {
	name: z.string().optional().describe("Defaults to its size, e.g. 3 × 3 × 6"),
	length_in: z.number().positive(),
	width_in: z.number().positive(),
	height_in: z.number().positive(),
	weight_oz: z.number().min(0).describe("The empty box"),
};

export function buildServer(db: Db, access: { canWrite: boolean }) {
	const server = new McpServer(
		{ name: "katasync", version: "1.0.0" },
		{ instructions: INSTRUCTIONS },
	);

	// Reading

	server.registerTool(
		"describe_schema",
		{
			description:
				"Every table and view the query tool can read, with columns and types.",
			annotations: READ,
		},
		async () => json(await describeSchema(db)),
	);

	server.registerTool(
		"query",
		{
			description: `Runs one read-only SQL SELECT (Postgres) and returns its rows. Writes are refused. Up to ${MAX_ROWS} rows.`,
			inputSchema: {
				sql: z.string(),
				limit: z.number().int().min(1).max(MAX_ROWS).optional(),
			},
			annotations: READ,
		},
		async ({ sql, limit }) => json(await readOnlyQuery(sql, limit)),
	);

	server.registerTool(
		"sync_status",
		{
			description:
				"Health of order sync per channel (Shopify, eBay, Amazon, TikTok): last good sync, the exact latest error, a hint for known causes, problems in the latest pass, and recent passes. Also whether the sync worker runs, labels whose tracking didn't reach a marketplace, and sold SKUs matching no product. With check, also runs a live step-by-step connection check.",
			inputSchema: {
				check: z
					.enum(["shopify", "ebay", "amazon", "tiktok", "shippo", "email"])
					.optional()
					.describe("Run a live connection check of this service"),
			},
			annotations: { ...READ, openWorldHint: true },
		},
		async ({ check }) =>
			json({
				...(await diagnosticsOverview(db)),
				...(check ? { check: await runCheck(check as CheckTarget) } : {}),
			}),
	);

	server.registerTool(
		"reorder_suggestions",
		{
			description:
				"What each supplier should be sent today: per product, units sold in the last 90 days, on hand, on order, and the quantity to order in the supplier's unit. Accounts for lead time, cover days, minimums, and open POs.",
			inputSchema: {
				supplier: z.string().optional().describe("Code or name"),
			},
			annotations: READ,
		},
		async ({ supplier }) => {
			const all = await suggestPurchases(db);
			if (!supplier) return json(all);
			const { id } = await supplierByRef(db, supplier);
			return json(all.filter((s) => s.supplierId === id));
		},
	);

	server.registerTool(
		"get_purchase_order",
		{
			description:
				"A PO with its supplier, delivery location, and lines (unit, pack size, minimum, quantity, price, received).",
			inputSchema: { id: z.number().int().positive() },
			annotations: READ,
		},
		async ({ id }) => json(await loadOrder(db, id)),
	);

	server.registerTool(
		"list_purchase_units",
		{
			description:
				"The units products can be bought in, and how many products use each.",
			annotations: READ,
		},
		async () => json(await listUnits(db)),
	);

	if (access.canWrite) registerWriteTools(server, db);
	return server;
}

// Tools that change things. Only tokens allowed to write get them, and
// src/routes/mcp.ts logs every call to them.
function registerWriteTools(server: McpServer, db: Db) {
	// Draft POs

	server.registerTool(
		"set_draft_po_lines",
		{
			description:
				"Sets how many of each product the draft POs order, putting each on its supplier's draft (made if needed). Say whether quantities count single items or the product's purchase unit (e.g. CASE of 12): items are rounded up to whole units, and the result says what that came to. 0 takes a line off. A line already on the draft is set to the new quantity, not added to. Products without a supplier, tool sets, and unknown SKUs are skipped and reported.",
			inputSchema: {
				quantity_in: z
					.enum(["items", "purchase_unit"])
					.describe(
						"items: single pieces, as stock and sales count them. purchase_unit: the unit the supplier sells in.",
					),
				lines: z
					.array(
						z.object({
							sku: z.string(),
							quantity: z.number().int().min(0),
							unit_cost: z
								.number()
								.min(0)
								.optional()
								.describe(
									"Per purchase unit; omitted keeps or uses the supplier's price",
								),
						}),
					)
					.min(1),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ quantity_in, lines }) => {
			const drafts = new Map<
				number,
				{ po: number; supplier: string; set: unknown[] }
			>();
			const skipped: { sku: string; reason: string }[] = [];
			for (const line of lines) {
				try {
					const product = await productBySku(db, line.sku);
					const [link] = await db
						.select({ supplierId: productSuppliers.supplierId })
						.from(productSuppliers)
						.where(eq(productSuppliers.productId, product.id));
					if (!link) {
						skipped.push({ sku: line.sku, reason: "no supplier set" });
						continue;
					}
					const po = await openDraft(db, link.supplierId);
					// A line already on the draft may be in its own unit (set on
					// just this PO); quantities count in that. Read under the PO's
					// lock, so the result is what was written.
					const { quantity, ...terms } = await setDraftLine(db, {
						purchaseOrderId: po,
						productId: product.id,
						quantity: line.quantity,
						inItems: quantity_in === "items",
						...(line.unit_cost !== undefined
							? { unitCost: line.unit_cost }
							: {}),
					});
					let draft = drafts.get(po);
					if (!draft) {
						const { supplier } = await loadOrder(db, po);
						draft = { po, supplier: supplier.name, set: [] };
						drafts.set(po, draft);
					}
					draft.set.push({
						sku: product.sku,
						quantity,
						unit: terms.unit,
						packSize: terms.packSize,
						items: quantity * terms.packSize,
						...(quantity > 0 && quantity < terms.minimumQuantity
							? {
									warning: `below the supplier's minimum of ${terms.minimumQuantity}`,
								}
							: {}),
					});
				} catch (error) {
					skipped.push({
						sku: line.sku,
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return json({ drafts: [...drafts.values()], skipped });
		},
	);

	server.registerTool(
		"draft_po_from_suggestions",
		{
			description:
				"Brings a supplier's draft PO up to date with reorder_suggestions, creating it if needed: adds suggested products and raises short lines. Never lowers or removes a line.",
			inputSchema: { supplier: z.string().describe("Code or name") },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ supplier }) => {
			const { id } = await supplierByRef(db, supplier);
			const po = await draftFromSuggestions(db, id);
			return json(await loadOrder(db, po));
		},
	);

	server.registerTool(
		"set_po_line_terms",
		{
			description:
				"Changes the unit, pack size, and minimum of one line on a draft PO. The quantity and price convert to keep the same number of items. With make_default, the product's supplier default changes too.",
			inputSchema: {
				po: z.number().int().positive(),
				sku: z.string(),
				...unitTerms,
				make_default: z.boolean().default(false),
			},
			annotations: WRITE,
		},
		async ({ po, sku, unit, pack_size, minimum, make_default }) => {
			const product = await productBySku(db, sku);
			await setLineTerms(db, {
				purchaseOrderId: po,
				productId: product.id,
				unit: unit.toUpperCase(),
				packSize: pack_size,
				minimumQuantity: minimum,
				makeDefault: make_default,
			});
			return json(await loadOrder(db, po));
		},
	);

	server.registerTool(
		"edit_draft_po",
		{
			description:
				"Changes a draft PO's notes (printed on it) or where it's delivered.",
			inputSchema: {
				po: z.number().int().positive(),
				notes: z.string().nullable().optional(),
				location: z
					.string()
					.optional()
					.describe("One of our locations, by name"),
			},
			annotations: WRITE,
		},
		async ({ po, notes, location }) => {
			await updateDraft(db, {
				purchaseOrderId: po,
				...(notes !== undefined ? { notes } : {}),
				...(location ? { locationId: await ownedLocation(db, location) } : {}),
			});
			return json(await loadOrder(db, po));
		},
	);

	server.registerTool(
		"delete_draft_po",
		{
			description:
				"Deletes a draft PO. Only drafts; sent POs are managed in the app.",
			inputSchema: { po: z.number().int().positive() },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ po }) => {
			await cancelOrder(db, po, new Date(), ["draft"]);
			return json({ deleted: po });
		},
	);

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
		"set_purchase_unit",
		{
			description:
				"Sets the default unit, pack size, and minimum a product is bought in. Its supplier price converts to the new size, and draft lines still on the old default follow.",
			inputSchema: { sku: z.string(), ...unitTerms },
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ sku, unit, pack_size, minimum }) => {
			const product = await productBySku(db, sku);
			await setPurchaseUnit(db, {
				productId: product.id,
				unit: unit.toUpperCase(),
				packSize: pack_size,
				minimumQuantity: minimum,
			});
			return json({ sku, unit: unit.toUpperCase(), pack_size, minimum });
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
				"Changes a supplier's details. Only given fields change. lead_time_days: days from sending a PO to delivery. cover_days: days of sales each PO should cover. minimum_order: spend (USD) at which a suggested PO counts as ready.",
			inputSchema: {
				supplier: z.string().describe("Code or name"),
				name: z.string().optional(),
				contact_name: z.string().nullable().optional(),
				email: z.string().email().nullable().optional(),
				phone: z.string().nullable().optional(),
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
				paymentTerms: input.payment_terms,
				notes: input.notes,
				poNotes: input.po_notes,
				leadTimeDays: input.lead_time_days,
				coverDays: input.cover_days,
				minimumOrder: input.minimum_order,
			});
			return json({ updated: input.supplier });
		},
	);

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
				"Matches a channel listing (listings.id) to the product it sells, then lets past orders of it take their stock. To make a new product from the listing instead, leave out sku.",
			inputSchema: {
				listing_id: z.number().int().positive(),
				sku: z.string().optional(),
			},
			annotations: WRITE,
		},
		async ({ listing_id, sku }) => {
			const [listing] = await db
				.select({ id: listings.id })
				.from(listings)
				.where(eq(listings.id, listing_id));
			if (!listing) throw new PurchaseOrderError(`No listing ${listing_id}`);
			return json(
				sku
					? await matchListing(db, listing_id, sku)
					: await productFromListing(db, listing_id),
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
				locationId: await ownedLocation(db, location),
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
			const requested = await requestCounts(db, {
				productIds,
				locationId: await ownedLocation(db, location),
			});
			return json({ requested });
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

	// Receiving

	server.registerTool(
		"receive_po_line",
		{
			description:
				"Records what arrived for one product on a sent PO, in the line's unit (2 cases of 12 puts 24 on the shelf). Updates the product's average cost and closes the PO once everything has arrived. Returns a receipt_id for undo_po_receipt.",
			inputSchema: {
				po: z.number().int().positive(),
				sku: z.string(),
				quantity: z.number().int().positive(),
			},
			annotations: WRITE,
		},
		async ({ po, sku, quantity }) => {
			const product = await productBySku(db, sku);
			const [line] = await db
				.select({ id: purchaseOrderLines.id })
				.from(purchaseOrderLines)
				.where(
					and(
						eq(purchaseOrderLines.purchaseOrderId, po),
						eq(purchaseOrderLines.productId, product.id),
					),
				);
			if (!line) throw new PurchaseOrderError(`${sku} isn't on PO ${po}`);
			const result = await receive(db, { lineId: line.id, quantity });
			return json({ po, sku, quantity, ...result });
		},
	);

	server.registerTool(
		"undo_po_receipt",
		{
			description:
				"Takes a receipt back off the shelf, e.g. one recorded by mistake. Reopens the PO if that leaves something short.",
			inputSchema: { receipt_id: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ receipt_id }) => {
			await undoReceipt(db, receipt_id);
			return json({ undone: receipt_id });
		},
	);
}
