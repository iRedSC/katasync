import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	type DamageReportItem,
	recordDamage,
	removeDamage,
	removeDamagePhoto,
	sendDamageReport,
} from "#/purchasing/damage";
import { sendEmail } from "#/purchasing/email";
import { loadOrder } from "#/purchasing/load";
import { PurchaseOrderError } from "#/purchasing/orders";
import { id } from "./id-input";

// Records items of a line that arrived damaged, in single items, and takes
// them off the shelf. Photos go to /api/damage-photos/$id after.
export const recordPurchaseDamage = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			quantity: "number.integer > 0",
			description: "string",
		}),
	)
	.handler(async ({ data }) => recordDamage(getDb(), data));

// Takes back damage not yet reported: the items go back on the shelf.
export const removePurchaseDamage = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeDamage(getDb(), data.id));

export const removePurchaseDamagePhoto = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeDamagePhoto(getDb(), data.id));

const REMEDY_WORDS = {
	credit: "please credit us",
	replacement: "please send replacements",
} as const;

// The report as the supplier reads it: each item, what's wrong, and what we
// ask for, with every photo attached and named for its item.
export function damageEmail(
	input: {
		purchaseOrderId: number;
		contactName: string | null;
		from: string;
	},
	items: DamageReportItem[],
) {
	const photoCount = items.reduce((n, i) => n + i.photos.length, 0);
	const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
	return {
		subject: `Damage on purchase order ${input.purchaseOrderId} from ${input.from}`,
		text: [
			input.contactName ? `Hi ${input.contactName},` : "Hello,",
			"",
			`Some of what arrived on purchase order ${input.purchaseOrderId} was damaged:`,
			"",
			...items.map(
				(i) =>
					`- ${i.quantity} × ${i.name} (${i.sku}): ${i.description}. ${REMEDY_WORDS[i.remedy][0].toUpperCase()}${REMEDY_WORDS[i.remedy].slice(1)}.`,
			),
			"",
			...(photoCount > 0
				? [
						`${photoCount === 1 ? "A photo is" : `${photoCount} photos are`} attached.`,
						"",
					]
				: []),
			"Thank you,",
			input.from,
		].join("\n"),
		attachments: items.flatMap((i) =>
			i.photos.map((p, n) => ({
				filename: `${i.sku}-${n + 1}.${ext[p.contentType as keyof typeof ext] ?? "jpg"}`,
				content: p.data,
			})),
		),
	};
}

// Emails the supplier every damage on the PO not yet reported, each with
// credit or replacement, and records it as sent. Nothing is recorded if the
// email fails.
export const sendPurchaseDamageReport = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			remedies: type({
				damageId: "number.integer > 0",
				remedy: "'credit' | 'replacement'",
			}).array(),
		}),
	)
	.handler(async ({ data }) =>
		sendDamageReport(getDb(), {
			...data,
			deliver: async (tx, items) => {
				const po = await loadOrder(tx, data.purchaseOrderId);
				const to = po.supplier.email;
				if (!to)
					throw new PurchaseOrderError(
						`${po.supplier.name} has no email. Add one in Suppliers.`,
					);
				await sendEmail({
					purchaseOrderId: data.purchaseOrderId,
					to,
					...damageEmail(
						{
							purchaseOrderId: data.purchaseOrderId,
							contactName: po.supplier.contactName,
							from: po.location.shipFromName ?? po.location.name,
						},
						items,
					),
				});
				return to;
			},
		}),
	);
