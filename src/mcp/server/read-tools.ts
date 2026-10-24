import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listUnmatched, suggestProducts } from "#/channels/unmatched";
import type { Db } from "#/db/client";
import { type CheckTarget, runCheck } from "#/diagnostics/checks";
import { diagnosticsOverview } from "#/diagnostics/overview";
import { COUNT_REASONS, countsDue } from "#/inventory/count-priority";
import { describeSchema, MAX_ROWS, readOnlyQuery } from "#/mcp/query";
import { listCatalogs } from "#/purchasing/catalogs";
import { type InvoiceLine, matchInvoice } from "#/purchasing/invoices";
import { suggestPurchases } from "#/purchasing/reorder";
import { supplierByRef } from "#/purchasing/suppliers";
import { listUnits } from "#/purchasing/units";
import { ourLocation } from "./lookups";
import { orderForClaude } from "./po-for-claude";
import { json, READ } from "./tool-shapes";

// Their line number on the invoice; defaults to its place in the list.
const theirLine = z
	.number()
	.int()
	.positive()
	.optional()
	.describe("Their line number; defaults to its place in this list");

// A line as the invoice shows it: merchandise, or a credit taking money off.
export const invoiceLineInput = z.union([
	z.object({
		kind: z.literal("merchandise").optional(),
		line: theirLine,
		sku: z.string().optional().describe("Our SKU, if shown"),
		supplier_sku: z.string().optional().describe("Their item number, if shown"),
		description: z.string().optional(),
		quantity: z
			.number()
			.int()
			.min(0)
			.describe("Shipped or billed, in their unit"),
		unit_cost: z.number().min(0).describe("Per their unit"),
	}),
	z.object({
		kind: z.literal("credit"),
		line: theirLine,
		description: z.string().optional(),
		amount: z.number().positive().describe("Dollars taken off the invoice"),
	}),
]);

// As matchInvoice takes it. A credit is never a negative price.
export function toInvoiceLine(
	l: z.infer<typeof invoiceLineInput>,
): InvoiceLine {
	if (l.kind === "credit")
		return {
			kind: "credit",
			line: l.line,
			description: l.description,
			amount: l.amount,
		};
	return {
		kind: "merchandise",
		line: l.line,
		sku: l.sku,
		supplierSku: l.supplier_sku,
		description: l.description,
		quantity: l.quantity,
		unitCost: l.unit_cost,
	};
}

export function registerReadTools(server: McpServer, db: Db) {
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
					.enum([
						"shopify",
						"ebay",
						"amazon",
						"tiktok",
						"shippo",
						"email",
						"inbox",
					])
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
		"catalogs",
		{
			description:
				"Every catalog (a line of products, e.g. Columbia) with how many products it holds and which suppliers carry it. A supplier sells every product in a catalog it carries; reorder buys each product from the supplier with the lowest price per single item.",
			inputSchema: {},
			annotations: READ,
		},
		async () => json(await listCatalogs(db)),
	);

	server.registerTool(
		"reorder_suggestions",
		{
			description:
				"What each supplier should be sent today: per product, units sold in the last 90 days, on hand, on order, and the quantity to order in the supplier's unit. Accounts for lead time, cover days, minimums, open POs, and tool sets a part leaves unsellable.",
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
		"counts_due",
		{
			description:
				"What to count next, across every shelf of ours, most urgent first. A shelf is due when on hand is below zero (oversold), someone asked for a count (requested), or it wasn't counted in the last 60 days (stale). Within each, A before B before C, then shelves whose counts keep missing (misses: counts in the last year that didn't match), then the longest waiting. Filters narrow the list without changing its order; each shelf carries what it was ranked on, so you can re-sort. Counting with record_count takes a shelf off; call again for the next. Returns how many match per reason and the first shelves.",
			inputSchema: {
				limit: z.number().int().min(1).max(200).default(10),
				reasons: z.array(z.enum(COUNT_REASONS)).min(1).optional(),
				abc: z
					.array(z.enum(["A", "B", "C", "none"]))
					.min(1)
					.optional()
					.describe("none: no class yet, e.g. sold with no cost"),
				category: z.string().optional().describe("Product type, e.g. Flat Box"),
				search: z.string().optional().describe("Part of a SKU or product name"),
				location: z
					.string()
					.optional()
					.describe("Only this location of ours, by name"),
			},
			annotations: READ,
		},
		async ({ limit, reasons, abc, category, search, location }) => {
			const locationId = location ? await ourLocation(db, location) : undefined;
			const now = new Date();
			const scope = {
				category: category || undefined,
				search: search?.trim() || undefined,
				locationId,
			};
			const { due } = await countsDue(db, now, scope);
			// A search or location that matches nothing isn't the same as a
			// category with no shelves due, so the category is checked alone.
			if (
				scope.category &&
				due.length === 0 &&
				(await countsDue(db, now, { category: scope.category })).due.length ===
					0
			) {
				const known = [
					...new Set(
						(await countsDue(db, now)).due.flatMap((s) =>
							s.category ? [s.category] : [],
						),
					),
				].sort();
				throw new Error(
					`No due shelves in category ${category}. Categories with due shelves: ${known.join(", ") || "none"}`,
				);
			}
			const matching = due.filter(
				(s) =>
					(!reasons || reasons.includes(s.reason)) &&
					(!abc || abc.includes(s.abc ?? "none")),
			);
			return json({
				due: matching.length,
				byReason: Object.fromEntries(
					COUNT_REASONS.map((r) => [
						r,
						matching.filter((s) => s.reason === r).length,
					]),
				),
				shelves: matching.slice(0, limit).map((s) => ({
					sku: s.sku,
					name: s.name,
					category: s.category,
					location: s.location,
					reason: s.reason,
					abc: s.abc,
					onHand: s.onHand,
					lastCountedAt: s.lastCountedAt,
					countRequestedAt: s.countRequestedAt,
					misses: s.misses,
				})),
			});
		},
	);

	server.registerTool(
		"get_purchase_order",
		{
			description:
				"A PO: status, supplier, totals (lines, quantity, items, dollars, received), recorded invoices, emails from the supplier (read_po_email), tracking (followed on Shippo), and lines (SKU, supplier SKU, unit and pack size, quantity, price, extended, received). A line shows what was sent only when it has changed since, and its default terms only when they differ.",
			inputSchema: { id: z.number().int().positive() },
			annotations: READ,
		},
		async ({ id }) => json(await orderForClaude(db, id)),
	);

	server.registerTool(
		"match_invoice",
		{
			description:
				"Checks a supplier invoice against its PO and changes nothing. Lines match by our SKU, then their item number (supplier_sku), then a description naming exactly one PO line. Returns whether it matches, totals, each line whose quantity or price differs, invoice lines not on the PO, PO lines not on the invoice, item numbers the products don't have yet (supplierSkusToSave, for set_supplier_skus), and whether the invoice number is already recorded. Quantities and prices are per the PO line's unit, as the invoice counts them. A discount or other deduction is a line with kind credit and its amount, not a negative price.",
			inputSchema: {
				po: z.number().int().positive(),
				invoice_number: z.string().optional(),
				total: z
					.number()
					.min(0)
					.optional()
					.describe("Total due on the invoice, freight and tax included"),
				freight: z.number().min(0).optional(),
				tax: z.number().min(0).optional(),
				lines: z.array(invoiceLineInput).min(1),
			},
			annotations: READ,
		},
		async ({ po, invoice_number, total, freight, tax, lines }) =>
			json(
				await matchInvoice(db, {
					purchaseOrderId: po,
					number: invoice_number,
					total,
					freight,
					tax,
					lines: lines.map(toInvoiceLine),
				}),
			),
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

	server.registerTool(
		"unmatched_listings",
		{
			description:
				"Listings no product backs, grouped into items, most units sold first: listing_ids, title, SKU (null when the channel has none), channels, fba, units and orders sold, last sold, and up to 6 likely products with the reason each was suggested. With order_id, only what that order sold. Never-sold items are left out unless include_unsold.",
			inputSchema: {
				order_id: z.number().int().positive().optional(),
				include_unsold: z.boolean().default(false),
			},
			annotations: READ,
		},
		async ({ order_id, include_unsold }) => {
			const items = await listUnmatched(
				db,
				order_id === undefined ? {} : { orderId: order_id },
			);
			return json(
				items
					.filter((i) => include_unsold || i.units > 0)
					.map((i) => ({
						listingIds: i.listingIds,
						title: i.title,
						sku: i.sku,
						channels: i.channels,
						...(i.fba ? { fba: true } : {}),
						units: i.units,
						orders: i.orders,
						lastSoldAt: i.lastSoldAt,
						candidates: i.candidates.map((c) => ({
							sku: c.sku,
							name: c.variantName ? `${c.name} (${c.variantName})` : c.name,
							reason: c.reason,
						})),
					})),
			);
		},
	);

	server.registerTool(
		"suggest_matches",
		{
			description:
				"Ranks products that could be the item a title and SKU describe, best first, with why: same-sku (SKU, alias, or supplier item number), matched-before (a listing with this title sells it), part-number (one of its codes is in the title), same-name, similar-name. For FBA listings, tool sets are left out. For a wider search, use query on products.",
			inputSchema: {
				title: z.string().min(1),
				sku: z.string().optional(),
				fba: z.boolean().default(false),
				limit: z.number().int().min(1).max(30).default(10),
			},
			annotations: READ,
		},
		async ({ title, sku, fba, limit }) =>
			json(
				(
					await suggestProducts(db, { title, sku: sku ?? null, fba }, limit)
				).map((c) => ({
					sku: c.sku,
					name: c.variantName ? `${c.name} (${c.variantName})` : c.name,
					...(c.kind !== "simple" ? { kind: c.kind } : {}),
					reason: c.reason,
				})),
			),
	);
}
