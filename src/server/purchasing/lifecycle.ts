import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";

import { sendEmail } from "#/purchasing/email";
import {
	greetingFor,
	renderTemplate,
	templateFor,
} from "#/purchasing/email-templates";
import { documentFor, loadOrder } from "#/purchasing/load";
import {
	cancelOrder,
	closeOrder,
	deleteDraft,
	markSent,
	orderAgain,
	PurchaseOrderError,
	poName,
	restoreDraft,
	restoreOrder,
	sentDay,
} from "#/purchasing/orders";
import { discount } from "./discount-input";
import { id } from "./id-input";

// The PO email as it would go, for staff to read and edit before sending.
export const previewPurchaseOrderEmail = createServerFn({ method: "GET" })
	.validator(id)
	.handler(async ({ data }) => {
		const db = getDb();
		const po = await loadOrder(db, data.id);
		const template = await templateFor(db, "purchase_order");
		const lines = po.lines.length;
		return {
			to: po.supplier.email,
			...renderTemplate<"purchase_order">(template, {
				greeting: greetingFor(po.supplier.contactName),
				po: String(data.id),
				supplier: po.supplier.name,
				from: po.location.shipFromName ?? po.location.name,
				items: `${lines} ${lines === 1 ? "item" : "items"}`,
			}),
			attachments: [`${poName(data.id).replace(" ", "-")}.pdf`],
		};
	});

// Emails the PO to the supplier, worded as previewed and edited, and puts it
// on order. With `email: false` it's only marked sent, for orders placed by
// phone or on the supplier's website, on `sentOn` when it went out before
// today.
export const sendPurchaseOrder = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			email: "false",
			// YYYY-MM-DD, which sentDay checks.
			"sentOn?": "string",
		}).or({
			id: "number.integer > 0",
			email: { subject: "/\\S/", text: "/\\S/" },
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		if (data.email === false) {
			// The same day as mark_po_sent takes: not ahead, not before the PO.
			const now = data.sentOn
				? await sentDay(db, data.id, data.sentOn)
				: undefined;
			await markSent(db, { purchaseOrderId: data.id, sentTo: null, now });
			return { sentTo: null };
		}
		const { email } = data;
		const sentTo = await markSent(db, {
			purchaseOrderId: data.id,
			// Built inside the send, with the PO locked, so the PDF matches
			// exactly what's saved as sent.
			deliver: async (tx) => {
				const { po, pdf, filename } = await documentFor(tx, data.id);
				const to = po.supplier.email;
				if (!to)
					throw new PurchaseOrderError(
						`${po.supplier.name} has no email. Add one in Suppliers, or mark it sent.`,
					);
				await sendEmail({
					purchaseOrderId: data.id,
					to,
					subject: email.subject,
					text: email.text,
					attachments: [{ filename, content: pdf }],
				});
				return to;
			},
		});
		return { sentTo };
	});

export const closePurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => closeOrder(getDb(), data.id));

export const cancelPurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => cancelOrder(getDb(), data.id));

// Undoes cancelPurchaseOrder: back on order.
export const restorePurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => restoreOrder(getDb(), data.id));

// Returns what was deleted, for restoreDraftPurchaseOrder.
export const deleteDraftPurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => deleteDraft(getDb(), data.id));

const positive = "number.integer > 0";

// Undoes deleteDraftPurchaseOrder with what it returned.
export const restoreDraftPurchaseOrder = createServerFn({ method: "POST" })
	.validator(
		type({
			id: positive,
			supplierId: positive,
			locationId: positive,
			notes: "string | null",
			coverDays: "number.integer | null",
			includePricier: "boolean",
			createdAt: "Date",
			lines: type({
				productId: positive,
				unit: "string",
				packSize: positive,
				supplierCount: positive,
				minimumQuantity: positive,
				quantity: "number.integer >= 0",
				unitCost: "number >= 0 | null",
				locked: "boolean",
				addedAt: "Date",
				discounts: discount.array(),
			}).array(),
			charges: type({
				kind: "'freight' | 'duty' | 'fee' | 'credit'",
				amount: "number",
				createdAt: "Date",
			}).array(),
			excludedCatalogIds: type(positive).array(),
			skippedParts: type({
				setProductId: positive,
				partProductId: positive,
			}).array(),
		}),
	)
	.handler(async ({ data }) => restoreDraft(getDb(), data));

// A finished PO's products onto its supplier's draft again.
export const orderPurchaseOrderAgain = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => orderAgain(getDb(), data.id));
