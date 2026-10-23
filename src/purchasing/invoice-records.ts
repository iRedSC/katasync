import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	supplierInvoiceDocuments,
	supplierInvoiceLines,
	supplierInvoiceVoids,
	supplierPaymentApplications,
} from "#/db/payables-schema";
import { supplierInvoices, suppliers } from "#/db/schema";
import { loadOrder } from "#/purchasing/load";
import { lockOrder, PurchaseOrderError, poName } from "#/purchasing/orders";
import { billingOf } from "./invoice-ledger";
import { findLine, type InvoiceLine } from "./invoice-lines";
import {
	actorOf,
	centsOf,
	currencyOf,
	lineAmountCents,
	type MatchableLine,
	MoneyError,
	priceUnits,
	type StaffContext,
} from "./invoice-matching";
import { lockSupplier } from "./payables";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const ANY_STATUS = [
	"suggested",
	"draft",
	"sent",
	"closed",
	"cancelled",
] as const;

export async function recordedInvoice(db: Db, supplierId: number, number: string) {
	const [found] = await db
		.select({
			invoice: supplierInvoices,
			voidId: supplierInvoiceVoids.id,
		})
		.from(supplierInvoices)
		.leftJoin(
			supplierInvoiceVoids,
			and(
				eq(supplierInvoiceVoids.invoiceId, supplierInvoices.id),
				isNull(supplierInvoiceVoids.restoredAt),
			),
		)
		.where(
			and(
				eq(supplierInvoices.supplierId, supplierId),
				sql`lower(${supplierInvoices.number}) = lower(${number.trim()})`,
			),
		);
	return found ? { ...found.invoice, voided: found.voidId !== null } : null;
}

export type RecordInvoiceInput = {
	purchaseOrderId: number;
	number: string;
	invoicedOn: string;
	dueOn?: string | null;
	total: number;
	currency?: string;
	freight?: number;
	tax?: number;
	lines?: InvoiceLine[];
};

type OrderLines = Awaited<ReturnType<typeof loadOrder>>["lines"];

export function evidenceOf(lines: InvoiceLine[], poLines: OrderLines) {
	const positions = new Set<number>();
	return lines.map((inv, i) => {
		const position = inv.line ?? i + 1;
		if (!Number.isInteger(position) || position < 1 || positions.has(position))
			throw new PurchaseOrderError(`Invoice line ${position} is given twice or isn't a line number`);
		positions.add(position);
		const ref = {
			position,
			sku: inv.sku?.trim() || null,
			supplierSku: inv.supplierSku?.trim() || null,
			description: inv.description?.trim() || null,
		};
		if (inv.kind === "credit") {
			const amountCents = centsOf(inv.amount, `Credit on line ${position}`);
			if (amountCents <= 0)
				throw new MoneyError(`Credit on line ${position} must be more than $0`);
			return {
				...ref,
				kind: "credit" as const,
				poLineId: null,
				unmatchedReason: null,
				quantity: null,
				unit: null,
				packSize: null,
				unitPrice: null,
				amountCents,
			};
		}
		if (!Number.isInteger(inv.quantity) || inv.quantity < 0)
			throw new PurchaseOrderError(`Line ${position}: quantity can't be ${inv.quantity}`);
		priceUnits(inv.unitCost, `Line ${position}'s unit price`);
		const match = findLine(poLines, inv);
		const packSize = inv.packSize ?? match.line?.packSize ?? 1;
		if (!Number.isInteger(packSize) || packSize < 1)
			throw new PurchaseOrderError(`Line ${position}: pack size can't be ${packSize}`);
		return {
			...ref,
			kind: "merchandise" as const,
			poLineId: match.line?.id ?? null,
			unmatchedReason: match.line ? null : match.reason,
			quantity: inv.quantity,
			unit: inv.unit?.trim() || match.line?.unit || "EACH",
			packSize,
			unitPrice: inv.unitCost,
			amountCents:
				inv.amount === undefined
					? lineAmountCents(inv.quantity, inv.unitCost)
					: centsOf(inv.amount, `Line ${position}'s amount`),
		};
	});
}

export function draftMatchable(
	evidence: ReturnType<typeof evidenceOf>,
): MatchableLine[] {
	return evidence.map((e) =>
		e.kind === "credit"
			? { kind: "credit", position: e.position, amountCents: e.amountCents }
			: {
					kind: "merchandise",
					position: e.position,
					poLineId: e.poLineId,
					unmatchedReason: e.unmatchedReason,
					quantity: e.quantity,
					packSize: e.packSize,
					unitPrice: e.unitPrice,
					amountCents: e.amountCents,
				},
	);
}

function validDay(day: string) {
	return DAY.test(day) && !Number.isNaN(Date.parse(day));
}

const isUniqueViolation = (e: unknown) => {
	const err = e as { code?: string; cause?: { code?: string } };
	return err.code === "23505" || err.cause?.code === "23505";
};

export async function recordInvoice(
	db: Db,
	input: RecordInvoiceInput,
	ctx: StaffContext = {},
) {
	const number = input.number.trim();
	if (!number) throw new PurchaseOrderError("Give the invoice's number");
	for (const day of [input.invoicedOn, input.dueOn])
		if (day != null && !validDay(day))
			throw new PurchaseOrderError(`${day} isn't a date like 2026-10-17`);
	if (input.dueOn && input.dueOn < input.invoicedOn)
		throw new PurchaseOrderError("It can't be due before it was invoiced");
	if (!(Number.isFinite(input.total) && input.total >= 0))
		throw new PurchaseOrderError(`Total can't be ${input.total}`);
	const currency = currencyOf(input.currency);
	const totalCents = centsOf(input.total, "Total");
	const freightCents = centsOf(input.freight ?? 0, "Freight");
	const taxCents = centsOf(input.tax ?? 0, "Tax");
	if (freightCents < 0 || taxCents < 0)
		throw new MoneyError("Freight and tax can't be negative");
	try {
		return await db.transaction(async (tx) => {
			const po = await lockOrder(tx, input.purchaseOrderId, [...ANY_STATUS]);
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
					already.voided
						? `${supplier.name} invoice ${already.number} was voided on ${poName(already.purchaseOrderId)}. Restore it there.`
						: `${supplier.name} invoice ${already.number} is already recorded on ${poName(already.purchaseOrderId)}`,
				);
			}
			const { lines: poLines } = await loadOrder(tx, po.id);
			const evidence = evidenceOf(input.lines ?? [], poLines);
			const [saved] = await tx
				.insert(supplierInvoices)
				.values({
					purchaseOrderId: po.id,
					supplierId: po.supplierId,
					number,
					invoicedOn: input.invoicedOn,
					dueOn: input.dueOn ?? null,
					total: totalCents / 100,
				})
				.returning();
			await tx.insert(supplierInvoiceDocuments).values({
				invoiceId: saved.id,
				currency,
				freightCents,
				taxCents,
				recordedBy: actorOf(ctx),
			});
			if (evidence.length > 0)
				await tx
					.insert(supplierInvoiceLines)
					.values(evidence.map((e) => ({ ...e, invoiceId: saved.id })));
			return withBilling(tx, saved);
		});
	} catch (e) {
		if (isUniqueViolation(e))
			throw new PurchaseOrderError(`Invoice ${number} was just recorded elsewhere`);
		throw e;
	}
}

async function withBilling(db: Db, header: typeof supplierInvoices.$inferSelect) {
	const billing = await billingOf(db, header.purchaseOrderId);
	const mine = billing.invoices.find((i) => i.id === header.id);
	if (!mine) throw new PurchaseOrderError(`No invoice ${header.id}`);
	return mine;
}

async function lockedInvoice(db: Db, id: number) {
	const [header] = await db
		.select()
		.from(supplierInvoices)
		.where(eq(supplierInvoices.id, id));
	if (!header) throw new PurchaseOrderError(`No invoice ${id}`);
	await lockOrder(db, header.purchaseOrderId, [...ANY_STATUS]);
	return header;
}

export async function voidInvoice(
	db: Db,
	input: { id: number; reason?: string | null },
	ctx: StaffContext = {},
) {
	return db.transaction(async (tx) => {
		const header = await lockedInvoice(tx, input.id);
		await lockSupplier(tx, header.supplierId);
		const [open] = await tx
			.select()
			.from(supplierInvoiceVoids)
			.where(
				and(
					eq(supplierInvoiceVoids.invoiceId, header.id),
					isNull(supplierInvoiceVoids.restoredAt),
				),
			);
		if (open) return { invoice: await withBilling(tx, header), releasedCents: 0 };
		await tx.insert(supplierInvoiceVoids).values({
			invoiceId: header.id,
			reason: input.reason?.trim() || null,
			voidedBy: actorOf(ctx),
		});
		const released = await tx
			.update(supplierPaymentApplications)
			.set({ reversedAt: sql`now()`, reversedBy: actorOf(ctx) })
			.where(
				and(
					eq(supplierPaymentApplications.invoiceId, header.id),
					isNull(supplierPaymentApplications.reversedAt),
				),
			)
			.returning({ cents: supplierPaymentApplications.amountCents });
		return {
			invoice: await withBilling(tx, header),
			releasedCents: released.reduce((n, r) => n + r.cents, 0),
		};
	});
}

export async function restoreInvoice(
	db: Db,
	input: { id: number },
	ctx: StaffContext = {},
) {
	return db.transaction(async (tx) => {
		const header = await lockedInvoice(tx, input.id);
		await tx
			.update(supplierInvoiceVoids)
			.set({ restoredAt: sql`now()`, restoredBy: actorOf(ctx) })
			.where(
				and(
					eq(supplierInvoiceVoids.invoiceId, header.id),
					isNull(supplierInvoiceVoids.restoredAt),
				),
			);
		return withBilling(tx, header);
	});
}

export async function removeInvoice(db: Db, id: number) {
	return (await voidInvoice(db, { id })).invoice;
}
