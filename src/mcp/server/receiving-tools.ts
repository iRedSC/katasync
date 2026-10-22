import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { relyingParty } from "#/auth/webauthn";
import type { Db } from "#/db/client";
import { purchaseOrderLines } from "#/db/schema";
import {
	createPhotoUploadLink,
	recordDamage,
	removeDamage,
} from "#/purchasing/damage";
import { MAX_PHOTO_BYTES, MAX_PHOTOS } from "#/purchasing/damage-limits";
import {
	PurchaseOrderError,
	receive,
	setBackOrdered,
	setReceivingNote,
	undoReceipt,
} from "#/purchasing/orders";
import { productBySku } from "./lookups";
import { discountShape, json, offOf, WRITE } from "./tool-shapes";

// The link Claude uploads a damage's photos to, and how.
async function photoLink(db: Db, damageId: number) {
	const { token, expiresAt } = await createPhotoUploadLink(db, damageId);
	const url = `${relyingParty().origin}/api/uploads/damage/${token}`;
	return {
		url,
		expiresAt,
		how: `curl -F photo=@damage.jpg ${url}  (one photo per request, JPEG, PNG, or WebP, up to ${MAX_PHOTO_BYTES / 1_000_000} MB each, ${MAX_PHOTOS} per damage)`,
	};
}

export function registerReceivingTools(server: McpServer, db: Db) {
	// Receiving

	server.registerTool(
		"receive_po_line",
		{
			description:
				"Records what arrived for one product on a sent PO, in the line's unit (2 cases of 12 puts 24 on the shelf). Updates the product's average cost and closes the PO once everything has arrived. With discount, part or all of what arrived came free or discounted (e.g. 1 free, or $12 off the 4 that are dented): it goes on the line with this receipt, the stock's cost reflects it, and undoing the receipt takes it off. Returns a receipt_id for undo_po_receipt.",
			inputSchema: {
				po: z.number().int().positive(),
				sku: z.string(),
				quantity: z.number().int().positive(),
				discount: z
					.object({
						units: z
							.number()
							.int()
							.positive()
							.optional()
							.describe(
								"How many of what arrived it covers; all of them when left out",
							),
						...discountShape,
					})
					.optional(),
			},
			annotations: WRITE,
		},
		async ({ po, sku, quantity, discount }) => {
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
			const result = await receive(db, {
				lineId: line.id,
				quantity,
				discount: discount && {
					units: discount.units,
					off: offOf(discount),
				},
			});
			return json({ po, sku, quantity, ...result });
		},
	);

	server.registerTool(
		"set_po_line_note",
		{
			description:
				'Puts a note on one product\'s line of a sent or closed PO for whoever is receiving it, e.g. "2 crushed, kept" or "rest due Friday". For back-ordered items, use set_po_line_back_ordered instead. Shown above the line on the receive page; never printed or sent to the supplier. Replaces any note already there; null or blank takes it off. get_purchase_order shows it as receivingNote. Returns the note it replaced.',
			inputSchema: {
				po: z.number().int().positive(),
				sku: z.string(),
				note: z.string().nullable(),
			},
			annotations: WRITE,
		},
		async ({ po, sku, note }) => {
			const line = await lineOf(db, po, sku);
			const result = await setReceivingNote(db, { lineId: line.id, note });
			return json({ po, sku, ...result });
		},
	);

	server.registerTool(
		"set_po_line_back_ordered",
		{
			description:
				"Marks one product's line of a sent PO back-ordered (true) or not (false): the supplier said what hasn't arrived is still coming, on no known day. The PO stays open; the receive page and PO show it as Back-ordered instead of Late, and reorder forecasts stop expecting it on the PO's date. Only while some of the line hasn't come; receiving the rest needs no unmarking. get_purchase_order shows it as backOrderedSince. Returns whether it was marked before.",
			inputSchema: {
				po: z.number().int().positive(),
				sku: z.string(),
				back_ordered: z.boolean(),
			},
			annotations: WRITE,
		},
		async ({ po, sku, back_ordered }) => {
			const line = await lineOf(db, po, sku);
			const result = await setBackOrdered(db, {
				lineId: line.id,
				backOrdered: back_ordered,
			});
			return json({ po, sku, back_ordered, ...result });
		},
	);

	server.registerTool(
		"report_damage",
		{
			description:
				"Records that some of what arrived for one product on a sent or closed PO is damaged, or missing from what arrived (a case of 12 holding 10 has 2 missing), in single items (2 blades of a case of 12 is 2). Damaged needs what's wrong; missing can leave it out. Takes them off the shelf at once, and can't exceed what arrived. Returns damage_id and a photo upload link for curl. The user sends the report to the supplier from the app; remove_damage takes it back until then.",
			inputSchema: {
				po: z.number().int().positive(),
				sku: z.string(),
				quantity: z
					.number()
					.int()
					.positive()
					.describe("Single items, not the line's unit"),
				kind: z.enum(["damaged", "missing"]).default("damaged"),
				description: z
					.string()
					.optional()
					.describe(
						'What\'s wrong, for the supplier, e.g. "crushed box, handles snapped". Required when damaged.',
					),
			},
			annotations: WRITE,
		},
		async ({ po, sku, quantity, kind, description }) => {
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
			const { damageId } = await recordDamage(
				db,
				kind === "missing"
					? { lineId: line.id, quantity, kind, description }
					: { lineId: line.id, quantity, kind, description: description ?? "" },
			);
			return json({
				po,
				sku,
				damageId,
				photoUpload: await photoLink(db, damageId),
			});
		},
	);

	server.registerTool(
		"damage_photo_link",
		{
			description:
				"A fresh link to upload photos of a damage with curl, when report_damage's has expired. Only until the damage is reported to the supplier.",
			inputSchema: { damage_id: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ damage_id }) => json(await photoLink(db, damage_id)),
	);

	server.registerTool(
		"remove_damage",
		{
			description:
				"Takes back damage recorded by mistake: the items go back on the shelf and its photos are deleted. Refused once the damage is reported to the supplier.",
			inputSchema: { damage_id: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ damage_id }) => {
			await removeDamage(db, damage_id);
			return json({ removed: damage_id });
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

// One product's line on a PO, by SKU.
async function lineOf(db: Db, po: number, sku: string) {
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
	return line;
}
