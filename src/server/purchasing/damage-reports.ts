import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	type DamageReportItem,
	damagesOf,
	type Remedy,
	recordDamage,
	removeDamage,
	removeDamagePhoto,
	sendDamageReport,
} from "#/purchasing/damage";
import { sendEmail } from "#/purchasing/email";
import {
	greetingFor,
	renderTemplate,
	templateFor,
	type Values,
} from "#/purchasing/email-templates";
import { loadOrder } from "#/purchasing/load";
import { PurchaseOrderError } from "#/purchasing/orders";
import { id } from "./id-input";

// Records items of a line that arrived damaged or were missing, in single
// items, and takes them off the shelf. Photos go to /api/damage-photos/$id
// after.
export const recordPurchaseDamage = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			quantity: "number.integer > 0",
			kind: "'damaged'",
			description: "string",
		}).or({
			lineId: "number.integer > 0",
			quantity: "number.integer > 0",
			kind: "'missing'",
			"description?": "string | null",
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
	credit: "Please credit us",
	replacement: "Please send replacements",
} as const;

type ReportLine = Pick<
	DamageReportItem,
	"sku" | "name" | "quantity" | "kind" | "description" | "remedy"
> & { photos: number };

// What's wrong with an item, as the supplier reads it.
const problem = (i: Pick<ReportLine, "kind" | "description">) =>
	i.kind === "missing"
		? `missing from the delivery${i.description ? `, ${i.description}` : ""}`
		: i.description;

// The report's wording, from the template; the damage list is laid out here.
function damageEmailValues(
	po: Awaited<ReturnType<typeof loadOrder>>,
	items: ReportLine[],
): Values<"damage_report"> {
	const photos = items.reduce((n, i) => n + i.photos, 0);
	return {
		greeting: greetingFor(po.supplier.contactName),
		po: String(po.order.id),
		supplier: po.supplier.name,
		from: po.location.shipFromName ?? po.location.name,
		damage_list: items
			.map(
				(i) =>
					`- ${i.quantity} × ${i.name} (${i.sku}): ${problem(i)}. ${REMEDY_WORDS[i.remedy]}.`,
			)
			.join("\n"),
		photos:
			photos === 0
				? ""
				: `${photos === 1 ? "A photo is" : `${photos} photos are`} attached.`,
	};
}

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Every photo, named for its item.
function photoFiles(
	items: { sku: string; photos: { contentType: string }[] }[],
) {
	return items.flatMap((i) =>
		i.photos.map((p, n) => ({
			filename: `${i.sku}-${n + 1}.${EXT[p.contentType as keyof typeof EXT] ?? "jpg"}`,
		})),
	);
}

const remediesInput = {
	purchaseOrderId: "number.integer > 0",
	remedies: type({
		damageId: "number.integer > 0",
		remedy: "'credit' | 'replacement'",
	}).array(),
} as const;

// The report as it would go, for staff to read and edit before sending.
export const previewDamageReport = createServerFn({ method: "POST" })
	.validator(type(remediesInput))
	.handler(async ({ data }) => {
		const db = getDb();
		const po = await loadOrder(db, data.purchaseOrderId);
		const chosen = new Map(data.remedies.map((r) => [r.damageId, r.remedy]));
		const pending = (await damagesOf(db, po.order.id)).filter(
			(d) => d.reportedAt === null && chosen.has(d.id),
		);
		const items = pending.map((d) => ({
			sku: d.sku,
			name: d.variantName ? `${d.name} (${d.variantName})` : d.name,
			quantity: d.quantity,
			kind: d.kind,
			description: d.description,
			remedy: chosen.get(d.id) as Remedy,
			photos: d.photoIds.length,
		}));
		const template = await templateFor(db, "damage_report");
		return {
			to: po.supplier.email,
			...renderTemplate(template, damageEmailValues(po, items)),
			attachments: pending.flatMap((d) =>
				d.photoIds.map((_, n) => `${d.sku}-${n + 1}`),
			),
		};
	});

// Emails the supplier every damage on the PO not yet reported, each with
// credit or replacement, and records it as sent. Nothing is recorded if the
// email fails.
export const sendPurchaseDamageReport = createServerFn({ method: "POST" })
	.validator(
		type({
			...remediesInput,
			// As previewed, and edited there.
			subject: "/\\S/",
			text: "/\\S/",
		}),
	)
	.handler(async ({ data }) =>
		sendDamageReport(getDb(), {
			purchaseOrderId: data.purchaseOrderId,
			remedies: data.remedies,
			deliver: async (tx, items) => {
				const po = await loadOrder(tx, data.purchaseOrderId);
				const to = po.supplier.email;
				if (!to)
					throw new PurchaseOrderError(
						`${po.supplier.name} has no email. Add one in Suppliers.`,
					);
				const names = photoFiles(items);
				await sendEmail({
					purchaseOrderId: data.purchaseOrderId,
					to,
					subject: data.subject,
					text: data.text,
					attachments: items
						.flatMap((i) => i.photos)
						.map((p, n) => ({ filename: names[n].filename, content: p.data })),
				});
				return to;
			},
		}),
	);
