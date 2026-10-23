import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	supplierInvoiceDocuments,
	supplierInvoiceLines,
	supplierInvoiceOpenings,
	supplierInvoiceVoids,
	supplierPaymentApplications,
} from "#/db/payables-schema";
import { supplierInvoices } from "#/db/schema";
import { lineCents } from "#/purchasing/discount";
import { loadOrder } from "#/purchasing/load";
import {
	type BillablePoLine,
	CURRENCY,
	type InvoiceMatch,
	type MatchableInvoice,
	type MatchableLine,
	matchBilling,
	paymentState,
	type InvoicePayment,
	type PoLineBilling,
} from "./invoice-matching";

export { type InvoicePayment, openCentsOf, paymentState } from "./invoice-matching";

export const totalCentsOf = (total: number) => Math.round(total * 100);

type Header = typeof supplierInvoices.$inferSelect;
type EvidenceLine = typeof supplierInvoiceLines.$inferSelect;

export type LedgerInvoice = Header & {
	currency: typeof CURRENCY;
	totalCents: number;
	freightCents: number;
	taxCents: number;
	recordedBy: string | null;
	legacy: boolean;
	lines: EvidenceLine[];
	voided: { at: Date; reason: string | null } | null;
	match: InvoiceMatch;
	payment: InvoicePayment;
};

export type OrderBilling = {
	invoices: LedgerInvoice[];
	lines: PoLineBilling[];
	unverifiedInvoices: number;
};

const sumCents = (column: typeof supplierPaymentApplications.amountCents) =>
	sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

export async function billingOf(
	db: Db,
	purchaseOrderId: number,
	draft?: MatchableInvoice,
): Promise<OrderBilling & { draft: InvoiceMatch | null }> {
	const po = await loadOrder(db, purchaseOrderId);
	const headers = await db
		.select()
		.from(supplierInvoices)
		.where(eq(supplierInvoices.purchaseOrderId, purchaseOrderId))
		.orderBy(supplierInvoices.invoicedOn, supplierInvoices.id);
	const ids = headers.length > 0 ? headers.map((h) => h.id) : [-1];
	const [documents, lines, voids, openings, applied] = await Promise.all([
		db
			.select()
			.from(supplierInvoiceDocuments)
			.where(inArray(supplierInvoiceDocuments.invoiceId, ids)),
		db
			.select()
			.from(supplierInvoiceLines)
			.where(inArray(supplierInvoiceLines.invoiceId, ids))
			.orderBy(asc(supplierInvoiceLines.position)),
		db
			.select()
			.from(supplierInvoiceVoids)
			.where(inArray(supplierInvoiceVoids.invoiceId, ids))
			.orderBy(asc(supplierInvoiceVoids.voidedAt)),
		db
			.select()
			.from(supplierInvoiceOpenings)
			.where(
				and(
					inArray(supplierInvoiceOpenings.invoiceId, ids),
					isNull(supplierInvoiceOpenings.withdrawnAt),
				),
			),
		db
			.select({
				invoiceId: supplierPaymentApplications.invoiceId,
				cents: sumCents(supplierPaymentApplications.amountCents),
			})
			.from(supplierPaymentApplications)
			.where(
				and(
					inArray(supplierPaymentApplications.invoiceId, ids),
					isNull(supplierPaymentApplications.reversedAt),
				),
			)
			.groupBy(supplierPaymentApplications.invoiceId),
	]);

	const documentOf = new Map(documents.map((d) => [d.invoiceId, d]));
	const linesOf = groupBy(lines, (l) => l.invoiceId);
	const voidsOf = groupBy(voids, (v) => v.invoiceId);
	const openingOf = new Map(openings.map((o) => [o.invoiceId, o.paidCents]));
	const appliedOf = new Map(applied.map((a) => [a.invoiceId, a.cents]));

	const poLines: BillablePoLine[] = po.lines.map((l) => {
		const net = lineCents(l, l.discounts);
		return {
			id: l.id,
			sku: l.sku,
			packSize: l.packSize,
			receivedUnits: l.received,
			prices:
				l.unitCost === null
					? []
					: net === null || l.quantity === 0
						? [l.unitCost]
						: [l.unitCost, Math.round((net * 100) / l.quantity) / 10_000],
		};
	});

	const matchable = headers.map((h): MatchableInvoice => {
		const history = voidsOf.get(h.id) ?? [];
		const restored = history.flatMap((v) => (v.restoredAt ? [v.restoredAt] : []));
		const document = documentOf.get(h.id);
		const evidence = linesOf.get(h.id) ?? [];
		return {
			id: h.id,
			totalCents: totalCentsOf(h.total),
			activeSince: restored.reduce((a, b) => (b > a ? b : a), h.createdAt),
			voided: history.some((v) => v.restoredAt === null),
			itemization: !document
				? { kind: "legacy" }
				: evidence.length === 0
					? { kind: "header_only" }
					: {
							kind: "itemized",
							freightCents: document.freightCents,
							taxCents: document.taxCents,
							lines: evidence.map(toMatchable),
						},
		};
	});

	const billing = matchBilling(poLines, draft ? [...matchable, draft] : matchable);

	return {
		invoices: headers.map((h): LedgerInvoice => {
			const document = documentOf.get(h.id);
			const open = (voidsOf.get(h.id) ?? []).find((v) => v.restoredAt === null);
			const totalCents = totalCentsOf(h.total);
			return {
				...h,
				currency: CURRENCY,
				totalCents,
				freightCents: document?.freightCents ?? 0,
				taxCents: document?.taxCents ?? 0,
				recordedBy: document?.recordedBy ?? null,
				legacy: !document,
				lines: linesOf.get(h.id) ?? [],
				voided: open ? { at: open.voidedAt, reason: open.reason } : null,
				match: billing.invoices.get(h.id) ?? { kind: "legacy" },
				payment: paymentState({
					totalCents,
					voided: open !== undefined,
					legacy: !document,
					openingCents: openingOf.get(h.id) ?? null,
					appliedCents: appliedOf.get(h.id) ?? 0,
				}),
			};
		}),
		lines: billing.lines,
		unverifiedInvoices: billing.unverifiedInvoices,
		draft: draft ? (billing.invoices.get(draft.id) ?? null) : null,
	};
}

function groupBy<T>(rows: T[], by: (row: T) => number) {
	const groups = new Map<number, T[]>();
	for (const row of rows) groups.set(by(row), [...(groups.get(by(row)) ?? []), row]);
	return groups;
}

function toMatchable(l: EvidenceLine): MatchableLine {
	if (l.kind === "credit")
		return { kind: "credit", position: l.position, amountCents: l.amountCents };
	if (l.quantity === null || l.packSize === null || l.unitPrice === null)
		throw new Error(`Invoice line ${l.id} is merchandise without its quantity, pack, or price`);
	return {
		kind: "merchandise",
		position: l.position,
		poLineId: l.poLineId,
		unmatchedReason: l.unmatchedReason,
		quantity: l.quantity,
		packSize: l.packSize,
		unitPrice: l.unitPrice,
		amountCents: l.amountCents,
	};
}

export async function invoicesOf(db: Db, purchaseOrderId: number) {
	return (await billingOf(db, purchaseOrderId)).invoices;
}
