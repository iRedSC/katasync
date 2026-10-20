import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { productSuppliers, purchaseOrderLines } from "#/db/schema";
import { recordInvoice, removeInvoice } from "#/purchasing/invoices";
import { loadOrder } from "#/purchasing/load";
import {
	addLine,
	amendLine,
	deleteDraft,
	draftFromSuggestions,
	markSent,
	openDraft,
	PurchaseOrderError,
	setDraftLine,
	updateDraft,
} from "#/purchasing/orders";
import { supplierByRef } from "#/purchasing/suppliers";
import { setLineTerms } from "#/purchasing/units";
import { registerDiscountTools } from "./discount-tools";
import { ourLocation, productBySku, sentDay } from "./lookups";
import { orderForClaude } from "./po-for-claude";
import { json, unitTerms, WRITE } from "./tool-shapes";

export function registerPurchasingTools(server: McpServer, db: Db) {
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
			return json(await orderForClaude(db, po));
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
		async ({
			po,
			sku,
			unit,
			pack_size,
			supplier_count,
			minimum,
			make_default,
		}) => {
			const product = await productBySku(db, sku);
			await setLineTerms(db, {
				purchaseOrderId: po,
				productId: product.id,
				unit: unit.toUpperCase(),
				packSize: pack_size,
				supplierCount: supplier_count ?? pack_size,
				minimumQuantity: minimum,
				makeDefault: make_default,
			});
			return json(await orderForClaude(db, po));
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
				...(location ? { locationId: await ourLocation(db, location) } : {}),
			});
			return json(await orderForClaude(db, po));
		},
	);

	server.registerTool(
		"mark_po_sent",
		{
			description:
				"Records that a draft PO already reached the supplier some other way (their invoice or shipment shows they have it), so it can be received. Contacts no one and prints nothing. Freezes the lines as sent; later changes (add_to_sent_po, adjust_sent_po_line) show against it. Ask the user before using it.",
			inputSchema: {
				po: z.number().int().positive(),
				sent_on: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe(
						"The day it went to the supplier, if known; defaults to now. Sets when it's expected, and lead times learn from it.",
					),
			},
			annotations: WRITE,
		},
		async ({ po, sent_on }) => {
			const now = sent_on ? await sentDay(db, po, sent_on) : undefined;
			await markSent(db, { purchaseOrderId: po, sentTo: null, now });
			return json(await orderForClaude(db, po));
		},
	);

	server.registerTool(
		"add_to_sent_po",
		{
			description:
				"Puts a product on a PO already sent, e.g. the supplier shipped or invoiced something extra we're keeping. Tells no one; the PO as sent stays as it was, and the line shows as amended. Quantity is in the product's purchase unit. Reopens a closed PO. A product already on the PO is refused: use adjust_sent_po_line. Drafts take set_draft_po_lines.",
			inputSchema: {
				po: z.number().int().positive(),
				sku: z.string(),
				quantity: z.number().int().positive(),
			},
			annotations: WRITE,
		},
		async ({ po, sku, quantity }) => {
			const product = await productBySku(db, sku);
			const { added, line } = await addLine(
				db,
				{ purchaseOrderId: po, productId: product.id, quantity },
				["sent", "closed"],
			);
			if (!added)
				throw new PurchaseOrderError(
					`${product.sku} is already on PO ${po} (${line.quantity} ${line.unit}); use adjust_sent_po_line`,
				);
			return json(await orderForClaude(db, po));
		},
	);

	server.registerTool(
		"adjust_sent_po_line",
		{
			description:
				"Changes the quantity or price of a line on a PO already sent, e.g. to agree with the supplier's invoice. Tells no one; the PO as sent stays as it was. Per the line's unit. A quantity can't go below what has arrived; 0 means no more are coming, and takes a line added after sending off if none arrived. Closes the PO when that leaves nothing to wait for, and reopens a closed one when it does. Returns what the line was, so it can be set back.",
			inputSchema: {
				po: z.number().int().positive(),
				sku: z.string(),
				quantity: z.number().int().min(0).optional(),
				unit_cost: z
					.number()
					.min(0)
					.nullable()
					.optional()
					.describe("Per the line's unit; null clears it"),
			},
			annotations: WRITE,
		},
		async ({ po, sku, quantity, unit_cost }) => {
			if (quantity === undefined && unit_cost === undefined)
				throw new PurchaseOrderError("Give a quantity, a unit_cost, or both");
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
			if (!line)
				throw new PurchaseOrderError(
					`${product.sku} isn't on PO ${po}; add_to_sent_po puts it on`,
				);
			const result = await amendLine(db, {
				lineId: line.id,
				quantity,
				unitCost: unit_cost,
			});
			return json({
				was: result.was,
				...(result.removed ? { removed: product.sku } : {}),
				...(result.receivedAtOldCost
					? {
							warning:
								"Some already arrived at the old price; that stock keeps its cost",
						}
					: {}),
				po: await orderForClaude(db, po),
			});
		},
	);

	// Discounts are registered here so the list keeps its order.
	registerDiscountTools(server, db);

	server.registerTool(
		"record_supplier_invoice",
		{
			description:
				"Keeps a supplier's invoice on its PO: number, date, due date, and total. The PO must be on order (sent or closed). The same invoice number from the same supplier is refused, on any PO, so nothing is paid twice. Check it with match_invoice first.",
			inputSchema: {
				po: z.number().int().positive(),
				number: z.string().min(1),
				invoiced_on: z.string().describe("YYYY-MM-DD"),
				due_on: z.string().nullable().optional().describe("YYYY-MM-DD"),
				total: z.number().min(0).describe("Total due, USD"),
			},
			annotations: WRITE,
		},
		async ({ po, number, invoiced_on, due_on, total }) =>
			json(
				await recordInvoice(db, {
					purchaseOrderId: po,
					number,
					invoicedOn: invoiced_on,
					dueOn: due_on,
					total,
				}),
			),
	);

	server.registerTool(
		"remove_supplier_invoice",
		{
			description:
				"Takes a recorded invoice off its PO, e.g. one put on the wrong PO. Its id is in get_purchase_order's invoices.",
			inputSchema: { id: z.number().int().positive() },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ id }) => json({ removed: await removeInvoice(db, id) }),
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
			await deleteDraft(db, po);
			return json({ deleted: po });
		},
	);
}
