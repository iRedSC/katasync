import type { Db } from "#/db/client";
import { damagesOf } from "#/purchasing/damage";
import {
	coveredUnits,
	type DiscountOff,
	describeDiscount,
	discountValues,
	lineCents,
} from "#/purchasing/discount";
import { emailsOf } from "#/purchasing/inbox/ingest";
import { invoicesOf } from "#/purchasing/invoices";
import { loadOrder } from "#/purchasing/load";
import { trackingOf } from "#/purchasing/tracking";

// A PO as Claude reads it: totals up front, and per line only what tells
// lines apart. Images, ids, and defaults equal to the line's terms are left
// out; a line's default terms show only when they differ.
export async function orderForClaude(db: Db, id: number) {
	const po = await loadOrder(db, id);
	const invoices = await invoicesOf(db, id);
	const damages = await damagesOf(db, id);
	const emails = await emailsOf(db, id);
	const tracking = await trackingOf(db, id);
	const priced = po.lines.filter((l) => l.unitCost !== null);
	const before = priced.reduce(
		(n, l) => n + Math.round(l.quantity * (l.unitCost ?? 0) * 100),
		0,
	);
	const after = priced.reduce(
		(n, l) => n + (lineCents(l, l.discounts) ?? 0),
		0,
	);
	return {
		id: po.order.id,
		status: po.order.status,
		supplier: {
			code: po.supplier.code,
			name: po.supplier.name,
			email: po.supplier.email,
			paymentTerms: po.supplier.paymentTerms,
		},
		deliverTo: po.location.name,
		notes: po.order.notes,
		createdAt: po.order.createdAt,
		sentAt: po.order.sentAt,
		sentTo: po.order.sentTo,
		expectedAt: po.order.expectedAt,
		closedAt: po.order.closedAt,
		totals: {
			lines: po.lines.length,
			// Summed in each line's own unit, as an invoice counts them.
			quantity: po.lines.reduce((n, l) => n + l.quantity, 0),
			items: po.lines.reduce((n, l) => n + l.quantity * l.packSize, 0),
			// After discounts.
			total: after / 100,
			...(before !== after ? { discounts: (before - after) / 100 } : {}),
			linesWithoutPrice: po.lines.length - priced.length,
			received: po.lines.reduce((n, l) => n + l.received, 0),
		},
		invoices: invoices.map((i) => ({
			id: i.id,
			number: i.number,
			invoicedOn: i.invoicedOn,
			dueOn: i.dueOn,
			total: i.total,
		})),
		// Read one with read_po_email.
		emails: emails.map((e) => ({
			id: e.id,
			from: e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress,
			subject: e.subject,
			receivedAt: e.receivedAt,
			matchedBy: e.matchedBy,
			attachments: e.attachments.map((a) => a.filename),
		})),
		tracking: tracking.map((t) => ({
			id: t.id,
			carrier: t.carrier,
			number: t.number,
			status: t.status,
			statusDetail: t.statusDetail,
			statusAt: t.statusAt,
			eta: t.eta,
			checkedAt: t.checkedAt,
			fromEmail: t.emailId,
		})),
		damages: damages.map((d) => ({
			damageId: d.id,
			sku: d.sku,
			quantity: d.quantity,
			description: d.description,
			photos: d.photoIds.length,
			...(d.reportedAt
				? {
						reported: {
							at: d.reportedAt,
							to: d.reportedTo,
							asked: d.remedy,
						},
					}
				: {}),
		})),
		lines: po.lines.map((l) => ({
			sku: l.sku,
			supplierSku: l.supplierSku,
			name: l.variantName ? `${l.name} (${l.variantName})` : l.name,
			...(l.kind !== "simple" ? { kind: l.kind } : {}),
			unit: l.unit,
			packSize: l.packSize,
			...(l.supplierCount !== l.packSize
				? { supplierCount: l.supplierCount }
				: {}),
			...(l.minimumQuantity > 1 ? { minimum: l.minimumQuantity } : {}),
			quantity: l.quantity,
			unitCost: l.unitCost,
			// After discounts.
			extended:
				lineCents(l, l.discounts) === null
					? null
					: (lineCents(l, l.discounts) ?? 0) / 100,
			...(l.discounts.length > 0 ? { discounts: discountsForClaude(l) } : {}),
			received: l.received,
			...(l.sentQuantity !== null &&
			(l.sentQuantity !== l.quantity || l.sentUnitCost !== l.unitCost)
				? { sent: { quantity: l.sentQuantity, unitCost: l.sentUnitCost } }
				: {}),
			...(l.locked ? { locked: true } : {}),
			...(l.receivingNote ? { receivingNote: l.receivingNote } : {}),
			...(l.linkSupplierId !== po.supplier.id
				? { note: "now bought from another supplier" }
				: l.defaultUnit !== l.unit ||
						l.defaultPackSize !== l.packSize ||
						l.defaultSupplierCount !== l.supplierCount ||
						l.defaultMinimum !== l.minimumQuantity
					? {
							defaultTerms: {
								unit: l.defaultUnit,
								packSize: l.defaultPackSize,
								supplierCount: l.defaultSupplierCount,
								minimum: l.defaultMinimum,
							},
						}
					: {}),
		})),
	};
}

// Each discount with its id (for remove_po_line_discount), what it says, the
// units it covers now, and the dollars it takes off.
function discountsForClaude(l: {
	quantity: number;
	unitCost: number | null;
	discounts: {
		id: number;
		units: number | "rest";
		off: DiscountOff;
		receiptId: number | null;
	}[];
}) {
	const units = coveredUnits(l.quantity, l.discounts);
	const values = discountValues(l, l.discounts);
	return l.discounts.map((d, i) => ({
		id: d.id,
		says: describeDiscount(d, units[i], l.discounts.length > 1),
		units: d.units === "rest" ? "all" : d.units,
		...(d.off.kind === "percent"
			? { percent: d.off.percent }
			: { amount: d.off.amount }),
		covers: units[i],
		off: values[i],
		...(d.receiptId !== null ? { cameWithReceipt: d.receiptId } : {}),
	}));
}
