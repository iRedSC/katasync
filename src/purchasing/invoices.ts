import type { Db } from "#/db/client";
import {
	coveredUnits,
	describeDiscount,
	lineCents,
} from "#/purchasing/discount";
import { loadOrder } from "#/purchasing/load";
import { poName } from "#/purchasing/orders";
import { describe, findLine, type InvoiceLine, key } from "./invoice-lines";

import { recordedInvoice } from "./invoice-records";

export { invoicesOf } from "./invoice-ledger";
export type { InvoiceLine } from "./invoice-lines";
export {
	recordInvoice,
	removeInvoice,
	restoreInvoice,
	voidInvoice,
} from "./invoice-records";

// Supplier invoices: checking one against its PO line by line, and keeping
// its number, date, and total on the PO so it can't be recorded twice.

type Merchandise = Extract<InvoiceLine, { kind: "merchandise" }>;
type Credit = Extract<InvoiceLine, { kind: "credit" }>;

type OrderLine = Awaited<ReturnType<typeof loadOrder>>["lines"][number];

// What the line comes to after its discounts, in cents.
const expectedCents = (l: OrderLine) => lineCents(l, l.discounts);

const discountsOf = (l: OrderLine) => {
	const units = coveredUnits(l.quantity, l.discounts);
	return l.discounts.map((d, i) =>
		describeDiscount(d, units[i], l.discounts.length > 1),
	);
};

const cents = (quantity: number, unitCost: number) =>
	Math.round(quantity * unitCost * 100);
const dollars = (c: number) => c / 100;

// Compares an invoice with its PO: each line's quantity and price against
// what the PO expects now (including changes made after sending), lines on
// one but not the other, and the totals. Changes nothing. A discounted line
// matches at its price before discounts (the invoice takes them off on lines
// of their own) or at the price after them (it bills the net).
export async function matchInvoice(
	db: Db,
	input: {
		purchaseOrderId: number;
		lines: InvoiceLine[];
		number?: string;
		// What the invoice says is due, freight and tax included.
		total?: number;
		freight?: number;
		tax?: number;
	},
) {
	const po = await loadOrder(db, input.purchaseOrderId);
	const taken = new Map<number, number>();
	const differences: {
		line: number;
		sku: string;
		name: string;
		matchedBy: "sku" | "supplier_sku" | "description";
		unit: string;
		issues: string[];
		po: {
			quantity: number;
			unitCost: number | null;
			discounts?: string[];
			total: number | null;
		};
		invoice: { quantity: number; unitCost: number };
		amountOver: number | null;
	}[] = [];
	const notOnPo: (Merchandise & { line: number; reason: string })[] = [];
	// Lines taking money off rather than billing a product, e.g. "Discount".
	const credits: (Credit & { line: number })[] = [];
	const supplierSkusToSave: { sku: string; supplierSku: string }[] = [];
	const supplierSkuConflicts: {
		sku: string;
		ours: string;
		invoice: string;
	}[] = [];
	let matching = 0;
	let invoicedCents = 0;

	input.lines.forEach((inv, i) => {
		const line = inv.line ?? i + 1;
		if (inv.kind === "credit") {
			invoicedCents -= Math.round(inv.amount * 100);
			credits.push({ ...inv, line });
			return;
		}
		invoicedCents += cents(inv.quantity, inv.unitCost);
		const match = findLine(po.lines, inv);
		if (!match.line) {
			notOnPo.push({ ...inv, line, reason: match.reason });
			return;
		}
		const l = match.line;
		const twice = taken.get(l.id);
		if (twice !== undefined) {
			notOnPo.push({
				...inv,
				line,
				reason: `${l.sku} is already billed on invoice line ${twice}`,
			});
			return;
		}
		taken.set(l.id, line);

		if (inv.supplierSku) {
			if (!l.supplierSku)
				supplierSkusToSave.push({ sku: l.sku, supplierSku: inv.supplierSku });
			else if (key(l.supplierSku) !== key(inv.supplierSku))
				supplierSkuConflicts.push({
					sku: l.sku,
					ours: l.supplierSku,
					invoice: inv.supplierSku,
				});
		}

		const issues: string[] = [];
		const expected = expectedCents(l);
		if (inv.quantity !== l.quantity) issues.push("quantity");
		if (l.unitCost === null) issues.push("PO has no price");
		else if (
			Math.round(l.unitCost * 10000) !== Math.round(inv.unitCost * 10000) &&
			!(
				inv.quantity === l.quantity &&
				cents(inv.quantity, inv.unitCost) === expected
			)
		)
			issues.push("price");
		if (issues.length === 0) {
			matching++;
			return;
		}
		differences.push({
			line,
			sku: l.sku,
			name: describe(l),
			matchedBy: match.by,
			unit: l.unit,
			issues,
			po: {
				quantity: l.quantity,
				unitCost: l.unitCost,
				...(l.discounts.length > 0 ? { discounts: discountsOf(l) } : {}),
				total: expected === null ? null : dollars(expected),
			},
			invoice: { quantity: inv.quantity, unitCost: inv.unitCost },
			amountOver:
				expected === null
					? null
					: dollars(cents(inv.quantity, inv.unitCost) - expected),
		});
	});

	const notOnInvoice = po.lines
		.filter((l) => !taken.has(l.id) && l.quantity > 0)
		.map((l) => ({
			sku: l.sku,
			name: describe(l),
			quantity: l.quantity,
			unit: l.unit,
			unitCost: l.unitCost,
		}));

	const poCents = po.lines.reduce((n, l) => n + (expectedCents(l) ?? 0), 0);
	const discountCents = po.lines.reduce(
		(n, l) =>
			n +
			(l.unitCost === null
				? 0
				: cents(l.quantity, l.unitCost) - (expectedCents(l) ?? 0)),
		0,
	);
	const extrasCents = Math.round(
		((input.freight ?? 0) + (input.tax ?? 0)) * 100,
	);
	const statedCents =
		input.total === undefined ? null : Math.round(input.total * 100);
	// The invoice's own arithmetic: its lines plus freight and tax should be
	// its total. Zero when it states none to check.
	const arithmeticCents =
		statedCents === null ? 0 : statedCents - invoicedCents - extrasCents;

	const already = input.number
		? await recordedInvoice(db, po.supplier.id, input.number)
		: null;

	return {
		po: po.order.id,
		status: po.order.status,
		supplier: po.supplier.name,
		...(po.order.status === "draft" || po.order.status === "suggested"
			? {
					warning: `${poName(po.order.id)} is still a ${po.order.status} here. If the supplier already has it, mark_po_sent records that, so it can be received.`,
				}
			: {}),
		...(already
			? {
					alreadyRecorded: already.voided
						? `Invoice ${already.number} was voided on ${poName(already.purchaseOrderId)}. Restore it there.`
						: `Invoice ${already.number} is already recorded on ${poName(already.purchaseOrderId)} (${already.total} USD)`,
				}
			: {}),
		// Lines can match at the price before discounts, so the invoice's lines
		// and credits must also come to what the PO does after them. And an
		// invoice whose stated total doesn't add up isn't a match either.
		matches:
			differences.length === 0 &&
			notOnPo.length === 0 &&
			notOnInvoice.length === 0 &&
			invoicedCents === poCents &&
			po.lines.every((l) => l.unitCost !== null) &&
			arithmeticCents === 0,
		totals: {
			poLines: po.lines.length,
			invoiceLines: input.lines.length,
			matchingLines: matching,
			poQuantity: po.lines.reduce((n, l) => n + l.quantity, 0),
			invoiceQuantity: input.lines.reduce(
				(n, l) => n + (l.kind === "merchandise" ? l.quantity : 0),
				0,
			),
			// After the PO's discounts, which poDiscounts adds up.
			poTotal: dollars(poCents),
			poDiscounts: dollars(discountCents),
			invoiceLinesTotal: dollars(invoicedCents),
			invoiceOverPo: dollars(invoicedCents - poCents),
			...(statedCents === null
				? {}
				: {
						invoiceTotal: dollars(statedCents),
						// The invoice's own arithmetic: its lines plus freight and
						// tax should be its total.
						invoiceArithmeticOff: dollars(arithmeticCents),
					}),
		},
		differences,
		notOnPo,
		credits,
		...(discountCents > 0 && invoicedCents - poCents === discountCents
			? {
					note: `The invoice comes to the PO before its $${dollars(discountCents).toFixed(2)} of discounts: they aren't taken off`,
				}
			: {}),
		notOnInvoice,
		supplierSkusToSave,
		supplierSkuConflicts,
	};
}
