import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { sendEmail } from "#/purchasing/email";
import { documentFor } from "#/purchasing/load";
import {
	cancelOrder,
	closeOrder,
	deleteDraft,
	markSent,
	orderAgain,
	PurchaseOrderError,
	restoreDraft,
	restoreOrder,
} from "#/purchasing/orders";
import { discount } from "./discount-input";
import { id } from "./id-input";

// Emails the PO to the supplier and puts it on order. With `email: false` it's
// only marked sent, for orders placed by phone or on the supplier's website.
export const sendPurchaseOrder = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", email: "boolean" }))
	.handler(async ({ data }) => {
		const db = getDb();
		if (!data.email) {
			await markSent(db, { purchaseOrderId: data.id, sentTo: null });
			return { sentTo: null };
		}
		const sentTo = await markSent(db, {
			purchaseOrderId: data.id,
			// Built inside the send, with the PO locked, so the email matches
			// exactly what's saved as sent.
			deliver: async (tx) => {
				const { po, pdf, filename } = await documentFor(tx, data.id);
				const to = po.supplier.email;
				if (!to)
					throw new PurchaseOrderError(
						`${po.supplier.name} has no email. Add one in Suppliers, or mark it sent.`,
					);
				const from = po.location.shipFromName ?? po.location.name;
				await sendEmail({
					purchaseOrderId: data.id,
					to,
					subject: `Purchase order ${data.id} from ${from}`,
					text: [
						po.supplier.contactName
							? `Hi ${po.supplier.contactName},`
							: "Hello,",
						"",
						`Please find purchase order ${data.id} attached (${po.lines.length} ${po.lines.length === 1 ? "item" : "items"}). Reply to this email to confirm, or with any changes or backorders.`,
						"",
						"Thank you,",
						from,
					].join("\n"),
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
			createdAt: "Date",
			lines: type({
				productId: positive,
				unit: "string",
				packSize: positive,
				supplierCount: positive,
				minimumQuantity: positive,
				quantity: "number.integer >= 0",
				unitCost: "number | null",
				discounts: discount.array(),
			}).array(),
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
