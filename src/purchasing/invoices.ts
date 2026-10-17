import { and, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { supplierInvoices, suppliers } from "#/db/schema";
import { loadOrder } from "#/purchasing/load";
import { lockOrder, PurchaseOrderError, poName } from "#/purchasing/orders";

// Supplier invoices: checking one against its PO line by line, and keeping
// its number, date, and total on the PO so it can't be recorded twice.

export type InvoiceLine = {
	// Their line number, echoed back so differences are easy to find on paper.
	line?: number;
	// Our SKU, when the invoice shows it.
	sku?: string;
	// Their item number.
	supplierSku?: string;
	description?: string;
	// In the PO line's unit, as the invoice counts: 12 packs, not 300 discs.
	quantity: number;
	unitCost: number;
};

type OrderLine = Awaited<ReturnType<typeof loadOrder>>["lines"][number];

// Letters and digits only, lowercased: "TT-07TT-C" and "tt07ttc" agree.
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const describe = (l: Pick<OrderLine, "name" | "variantName">) =>
	l.variantName ? `${l.name} (${l.variantName})` : l.name;

const cents = (quantity: number, unitCost: number) =>
	Math.round(quantity * unitCost * 100);
const dollars = (c: number) => c / 100;

type Match =
	| { line: OrderLine; by: "sku" | "supplier_sku" | "description" }
	| { line: null; reason: string };

// Finds the PO line an invoice line bills for. Our SKU first, then theirs,
// then the description, which must name exactly one line: a description that
// fits two lines matches neither, rather than a guess.
function findLine(lines: OrderLine[], inv: InvoiceLine): Match {
	if (inv.sku) {
		const found = lines.find((l) => key(l.sku) === key(inv.sku ?? ""));
		if (found) return { line: found, by: "sku" };
	}
	if (inv.supplierSku) {
		const found = lines.find(
			(l) => l.supplierSku && key(l.supplierSku) === key(inv.supplierSku ?? ""),
		);
		if (found) return { line: found, by: "supplier_sku" };
	}
	if (inv.description) {
		const wanted = key(inv.description);
		const fits = lines.filter(
			(l) =>
				key(describe(l)) === wanted ||
				// Invoices often put the item number in front: "196003 - Hinge".
				(l.supplierSku && wanted === key(l.supplierSku + describe(l))),
		);
		if (fits.length === 1) return { line: fits[0], by: "description" };
		if (fits.length > 1)
			return {
				line: null,
				reason: `description fits ${fits.map((l) => l.sku).join(", ")}`,
			};
	}
	return { line: null, reason: "not on the PO" };
}

// Compares an invoice with its PO: each line's quantity and price against
// what the PO expects now (including changes made after sending), lines on
// one but not the other, and the totals. Changes nothing.
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
		po: { quantity: number; unitCost: number | null };
		invoice: { quantity: number; unitCost: number };
		amountOver: number | null;
	}[] = [];
	const notOnPo: (InvoiceLine & { line: number; reason: string })[] = [];
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
		if (inv.quantity !== l.quantity) issues.push("quantity");
		if (l.unitCost === null) issues.push("PO has no price");
		else if (
			Math.round(l.unitCost * 10000) !== Math.round(inv.unitCost * 10000)
		)
			issues.push("price");
		if (issues.length === 0) {
			matching++;
			return;
		}
		const expected = l.unitCost === null ? null : cents(l.quantity, l.unitCost);
		differences.push({
			line,
			sku: l.sku,
			name: describe(l),
			matchedBy: match.by,
			unit: l.unit,
			issues,
			po: { quantity: l.quantity, unitCost: l.unitCost },
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

	const poCents = po.lines.reduce(
		(n, l) => n + (l.unitCost === null ? 0 : cents(l.quantity, l.unitCost)),
		0,
	);
	const extrasCents = Math.round(
		((input.freight ?? 0) + (input.tax ?? 0)) * 100,
	);
	const statedCents =
		input.total === undefined ? null : Math.round(input.total * 100);

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
					alreadyRecorded: `Invoice ${already.number} is already recorded on ${poName(already.purchaseOrderId)} (${already.total} USD)`,
				}
			: {}),
		matches:
			differences.length === 0 &&
			notOnPo.length === 0 &&
			notOnInvoice.length === 0 &&
			po.lines.every((l) => l.unitCost !== null),
		totals: {
			poLines: po.lines.length,
			invoiceLines: input.lines.length,
			matchingLines: matching,
			poQuantity: po.lines.reduce((n, l) => n + l.quantity, 0),
			invoiceQuantity: input.lines.reduce((n, l) => n + l.quantity, 0),
			poTotal: dollars(poCents),
			invoiceLinesTotal: dollars(invoicedCents),
			invoiceOverPo: dollars(invoicedCents - poCents),
			...(statedCents === null
				? {}
				: {
						invoiceTotal: dollars(statedCents),
						// The invoice's own arithmetic: its lines plus freight and
						// tax should be its total.
						invoiceArithmeticOff: dollars(
							statedCents - invoicedCents - extrasCents,
						),
					}),
		},
		differences,
		notOnPo,
		notOnInvoice,
		supplierSkusToSave,
		supplierSkuConflicts,
	};
}

async function recordedInvoice(db: Db, supplierId: number, number: string) {
	const [found] = await db
		.select()
		.from(supplierInvoices)
		.where(
			and(
				eq(supplierInvoices.supplierId, supplierId),
				sql`lower(${supplierInvoices.number}) = lower(${number.trim()})`,
			),
		);
	return found ?? null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Keeps an invoice on its PO. Only a PO that's on order can be billed: a
// draft hasn't been ordered here yet. The same number from the same supplier
// is refused, on any PO.
export async function recordInvoice(
	db: Db,
	input: {
		purchaseOrderId: number;
		number: string;
		invoicedOn: string;
		dueOn?: string | null;
		total: number;
	},
) {
	const number = input.number.trim();
	if (!number) throw new PurchaseOrderError("Give the invoice's number");
	for (const day of [input.invoicedOn, input.dueOn])
		if (day != null && !(DAY.test(day) && !Number.isNaN(Date.parse(day))))
			throw new PurchaseOrderError(`${day} isn't a date like 2026-10-17`);
	if (input.dueOn && input.dueOn < input.invoicedOn)
		throw new PurchaseOrderError("It can't be due before it was invoiced");
	if (!(Number.isFinite(input.total) && input.total >= 0))
		throw new PurchaseOrderError(`Total can't be ${input.total}`);
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, input.purchaseOrderId, [
			"suggested",
			"draft",
			"sent",
			"closed",
			"cancelled",
		]);
		if (po.status === "draft" || po.status === "suggested")
			throw new PurchaseOrderError(
				`${poName(po.id)} is a ${po.status}, not on order. Mark it sent first.`,
			);
		if (po.status === "cancelled")
			throw new PurchaseOrderError(`${poName(po.id)} was cancelled`);
		const already = await recordedInvoice(tx, po.supplierId, number);
		if (already) {
			const [supplier] = await tx
				.select({ name: suppliers.name })
				.from(suppliers)
				.where(eq(suppliers.id, po.supplierId));
			throw new PurchaseOrderError(
				`${supplier.name} invoice ${already.number} is already recorded on ${poName(already.purchaseOrderId)}`,
			);
		}
		const [saved] = await tx
			.insert(supplierInvoices)
			.values({
				purchaseOrderId: po.id,
				supplierId: po.supplierId,
				number,
				invoicedOn: input.invoicedOn,
				dueOn: input.dueOn ?? null,
				total: input.total,
			})
			.returning();
		return saved;
	});
}

// Takes an invoice off its PO, e.g. one recorded on the wrong PO.
export async function removeInvoice(db: Db, id: number) {
	const [removed] = await db
		.delete(supplierInvoices)
		.where(eq(supplierInvoices.id, id))
		.returning();
	if (!removed) throw new PurchaseOrderError(`No invoice ${id}`);
	return removed;
}

export function invoicesOf(db: Db, purchaseOrderId: number) {
	return db
		.select()
		.from(supplierInvoices)
		.where(eq(supplierInvoices.purchaseOrderId, purchaseOrderId))
		.orderBy(supplierInvoices.invoicedOn, supplierInvoices.id);
}
