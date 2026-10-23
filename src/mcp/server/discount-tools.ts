import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import { removeDiscount, saveDiscount } from "#/purchasing/orders";
import { lineOf } from "./lookups";
import { orderForClaude } from "./po-for-claude";
import { discountShape, json, offOf, WRITE } from "./tool-shapes";

export function registerDiscountTools(server: McpServer, db: Db) {
	server.registerTool(
		"set_po_line_discount",
		{
			description:
				"Puts a discount on a line of a draft or sent PO: a percent or dollars off some of its units, e.g. 10% off all, $12 off 4, or 100% off 1 (free). The amount is for those units together. units 'all' covers every unit no other discount on the line covers and follows the quantity; there can be one of those per line. Discounts can't cover more units than the line has, or take more than they cost. On a sent PO it tells no one and the PO as sent stays as it was; on a draft it prints on the PO when sent. Stock already received is revalued to match. replaces takes one of the line's discounts off in the same change, to edit it. For something discounted in a delivery, use receive_po_line's discount instead.",
			inputSchema: {
				po: z.number().int().positive(),
				sku: z.string(),
				units: z
					.union([z.number().int().positive(), z.literal("all")])
					.describe("How many of the line's unit, or all"),
				...discountShape,
				replaces: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Id of a discount on this line to take off in its place"),
				receipt_id: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(
						"Only to put back one that came with a delivery (remove_po_line_discount returns it), so undoing that receipt still takes it off. Together, the discounts on one delivery can't cover more units than came in it",
					),
			},
			annotations: WRITE,
		},
		async ({ po, sku, units, percent, amount, replaces, receipt_id }) => {
			const lineId = await lineOf(db, po, sku);
			const result = await saveDiscount(db, {
				lineId,
				discount: {
					units: units === "all" ? "rest" : units,
					off: offOf({ percent, amount }),
				},
				replaces,
				receiptId: receipt_id,
			});
			return json({
				discountId: result.id,
				po: await orderForClaude(db, po),
			});
		},
	);

	server.registerTool(
		"remove_po_line_discount",
		{
			description:
				"Takes a discount off a PO line. Its id is in get_purchase_order's line discounts. Returns it as it was, so set_po_line_discount can put it back.",
			inputSchema: {
				po: z.number().int().positive(),
				discount_id: z.number().int().positive(),
			},
			annotations: WRITE,
		},
		async ({ po, discount_id }) => {
			const removed = await removeDiscount(db, discount_id, po);
			return json({
				was: {
					units: removed.units === "rest" ? "all" : removed.units,
					...(removed.off.kind === "percent"
						? { percent: removed.off.percent }
						: { amount: removed.off.amount }),
					...(removed.receiptId !== null
						? { receipt_id: removed.receiptId }
						: {}),
				},
				po: await orderForClaude(db, po),
			});
		},
	);
}
