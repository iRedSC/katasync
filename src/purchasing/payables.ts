import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Actor } from "#/auth/actor";
import type { Db } from "#/db/client";
import {
	paymentMethods,
	supplierInvoiceDocuments,
	supplierInvoiceOpenings,
	supplierInvoiceVoids,
	supplierPaymentApplications,
	supplierPayments,
} from "#/db/payables-schema";
import { purchaseOrders, supplierInvoices, suppliers } from "#/db/schema";
import { PurchaseOrderError } from "#/purchasing/orders";
import { billingOf, totalCentsOf } from "./invoice-ledger";
import {
	CURRENCY,
	type Currency,
	currencyOf,
	MoneyError,
	wholeCents,
} from "./invoice-matching";
import { recordedBy } from "./recorded-by";

export type PaymentMethod = (typeof paymentMethods)[number];

export class PayableError extends PurchaseOrderError {
	name = "PayableError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function idOf(id: string, what: string) {
	if (!UUID.test(id)) throw new PayableError(`${what} id must be a UUID`);
	return id.toLowerCase();
}

function positiveCents(cents: number, what: string) {
	if (wholeCents(cents, what) <= 0) throw new MoneyError(`${what} must be more than $0`);
	return cents;
}

export async function lockSupplier(db: Db, supplierId: number) {
	const [found] = await db
		.select({ id: suppliers.id, name: suppliers.name })
		.from(suppliers)
		.where(eq(suppliers.id, supplierId))
		.for("no key update");
	if (!found) throw new PayableError(`No supplier ${supplierId}`);
	return found;
}

const sumOf = (column: typeof supplierPaymentApplications.amountCents) =>
	sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

async function appliedToPayment(db: Db, paymentId: string) {
	const [row] = await db
		.select({ cents: sumOf(supplierPaymentApplications.amountCents) })
		.from(supplierPaymentApplications)
		.where(
			and(
				eq(supplierPaymentApplications.paymentId, paymentId),
				isNull(supplierPaymentApplications.reversedAt),
			),
		);
	return row.cents;
}

async function invoiceRoom(db: Db, invoiceId: number) {
	const [header] = await db
		.select({
			invoice: supplierInvoices,
			voidId: supplierInvoiceVoids.id,
			opening: supplierInvoiceOpenings.paidCents,
			documented: supplierInvoiceDocuments.invoiceId,
		})
		.from(supplierInvoices)
		.leftJoin(
			supplierInvoiceVoids,
			and(
				eq(supplierInvoiceVoids.invoiceId, supplierInvoices.id),
				isNull(supplierInvoiceVoids.restoredAt),
			),
		)
		.leftJoin(
			supplierInvoiceOpenings,
			and(
				eq(supplierInvoiceOpenings.invoiceId, supplierInvoices.id),
				isNull(supplierInvoiceOpenings.withdrawnAt),
			),
		)
		.leftJoin(
			supplierInvoiceDocuments,
			eq(supplierInvoiceDocuments.invoiceId, supplierInvoices.id),
		)
		.where(eq(supplierInvoices.id, invoiceId));
	if (!header) throw new PayableError(`No invoice ${invoiceId}`);
	const [applied] = await db
		.select({ cents: sumOf(supplierPaymentApplications.amountCents) })
		.from(supplierPaymentApplications)
		.where(
			and(
				eq(supplierPaymentApplications.invoiceId, invoiceId),
				isNull(supplierPaymentApplications.reversedAt),
			),
		);
	const totalCents = totalCentsOf(header.invoice.total);
	return {
		invoice: header.invoice,
		voided: header.voidId !== null,
		legacy: header.documented === null,
		openingCents: header.opening,
		appliedCents: applied.cents,
		openCents: totalCents - (header.opening ?? 0) - applied.cents,
	};
}

type Payment = typeof supplierPayments.$inferSelect;

async function applyWithin(
	db: Db,
	payment: Payment,
	application: { id: string; invoiceId: number; amountCents: number },
	actor: Actor,
) {
	const id = idOf(application.id, "Application");
	const amountCents = positiveCents(application.amountCents, "Applied amount");
	const [replay] = await db
		.select()
		.from(supplierPaymentApplications)
		.where(eq(supplierPaymentApplications.id, id));
	if (replay) {
		if (
			replay.paymentId !== payment.id ||
			replay.invoiceId !== application.invoiceId ||
			replay.amountCents !== amountCents
		)
			throw new PayableError(`Application ${id} was recorded differently`);
		return replay;
	}
	if (payment.reversedAt) throw new PayableError("That payment was reversed");
	const room = await invoiceRoom(db, application.invoiceId);
	if (room.invoice.supplierId !== payment.supplierId)
		throw new PayableError(`Invoice ${room.invoice.number} is another supplier's`);
	if (room.voided) throw new PayableError(`Invoice ${room.invoice.number} is void`);
	if (amountCents > room.openCents)
		throw new PayableError(
			`Invoice ${room.invoice.number} has only $${(room.openCents / 100).toFixed(2)} open`,
		);
	const unapplied = payment.amountCents - (await appliedToPayment(db, payment.id));
	if (amountCents > unapplied)
		throw new PayableError(
			`The payment has only $${(unapplied / 100).toFixed(2)} unapplied`,
		);
	const [saved] = await db
		.insert(supplierPaymentApplications)
		.values({
			id,
			paymentId: payment.id,
			supplierId: payment.supplierId,
			invoiceId: application.invoiceId,
			amountCents,
			appliedBy: recordedBy(actor),
		})
		.returning();
	return saved;
}

export type RecordPaymentInput = {
	id: string;
	supplierId: number;
	amountCents: number;
	currency?: string;
	paidOn: string;
	method: PaymentMethod;
	reference?: string | null;
	applications?: { id: string; invoiceId: number; amountCents: number }[];
};

export async function recordPayment(
	db: Db,
	input: RecordPaymentInput,
	actor: Actor,
) {
	const id = idOf(input.id, "Payment");
	const amountCents = positiveCents(input.amountCents, "Payment");
	currencyOf(input.currency);
	if (!(DAY.test(input.paidOn) && !Number.isNaN(Date.parse(input.paidOn))))
		throw new PayableError(`${input.paidOn} isn't a date like 2026-10-17`);
	if (!paymentMethods.includes(input.method))
		throw new PayableError(`${input.method} isn't a payment method`);
	const applications = input.applications ?? [];
	const appliedCents = applications.reduce(
		(n, a) => n + positiveCents(a.amountCents, "Applied amount"),
		0,
	);
	if (appliedCents > amountCents)
		throw new MoneyError("A payment can't apply more than it paid");
	if (new Set(applications.map((a) => a.invoiceId)).size !== applications.length)
		throw new PayableError("Apply to each invoice once");
	const reference = input.reference?.trim() || null;
	return db.transaction(async (tx) => {
		await lockSupplier(tx, input.supplierId);
		const [replay] = await tx
			.select()
			.from(supplierPayments)
			.where(eq(supplierPayments.id, id));
		if (replay) {
			if (
				replay.supplierId !== input.supplierId ||
				replay.amountCents !== amountCents ||
				replay.paidOn !== input.paidOn ||
				replay.method !== input.method ||
				replay.reference !== reference
			)
				throw new PayableError(`Payment ${id} was recorded differently`);
			return evidenceOne(tx, id);
		}
		const [payment] = await tx
			.insert(supplierPayments)
			.values({
				id,
				supplierId: input.supplierId,
				currency: CURRENCY,
				amountCents,
				paidOn: input.paidOn,
				method: input.method,
				reference,
				recordedBy: recordedBy(actor),
			})
			.returning();
		for (const a of applications) await applyWithin(tx, payment, a, actor);
		return evidenceOne(tx, id);
	});
}

async function lockedPayment(db: Db, paymentId: string) {
	const id = idOf(paymentId, "Payment");
	const [found] = await db
		.select({ supplierId: supplierPayments.supplierId })
		.from(supplierPayments)
		.where(eq(supplierPayments.id, id));
	if (!found) throw new PayableError(`No payment ${id}`);
	await lockSupplier(db, found.supplierId);
	const [payment] = await db
		.select()
		.from(supplierPayments)
		.where(eq(supplierPayments.id, id));
	return payment;
}

export async function applyCredit(
	db: Db,
	input: { id: string; paymentId: string; invoiceId: number; amountCents: number },
	actor: Actor,
) {
	return db.transaction(async (tx) => {
		const payment = await lockedPayment(tx, input.paymentId);
		await applyWithin(tx, payment, input, actor);
		return evidenceOne(tx, payment.id);
	});
}

export async function unapplyPayment(
	db: Db,
	input: { applicationId: string },
	actor: Actor,
) {
	const id = idOf(input.applicationId, "Application");
	return db.transaction(async (tx) => {
		const [found] = await tx
			.select()
			.from(supplierPaymentApplications)
			.where(eq(supplierPaymentApplications.id, id));
		if (!found) throw new PayableError(`No application ${id}`);
		await lockSupplier(tx, found.supplierId);
		await tx
			.update(supplierPaymentApplications)
			.set({ reversedAt: sql`now()`, reversedBy: recordedBy(actor) })
			.where(
				and(
					eq(supplierPaymentApplications.id, id),
					isNull(supplierPaymentApplications.reversedAt),
				),
			);
		return evidenceOne(tx, found.paymentId);
	});
}

export async function reversePayment(
	db: Db,
	input: { paymentId: string; reason?: string | null },
	actor: Actor,
) {
	return db.transaction(async (tx) => {
		const payment = await lockedPayment(tx, input.paymentId);
		const reversed = await tx
			.update(supplierPayments)
			.set({
				reversedAt: sql`now()`,
				reversedBy: recordedBy(actor),
				reversalReason: input.reason?.trim() || null,
			})
			.where(and(eq(supplierPayments.id, payment.id), isNull(supplierPayments.reversedAt)))
			.returning({ id: supplierPayments.id });
		if (reversed.length > 0)
			await tx
				.update(supplierPaymentApplications)
				.set({ reversedAt: sql`now()`, reversedBy: recordedBy(actor) })
				.where(
					and(
						eq(supplierPaymentApplications.paymentId, payment.id),
						isNull(supplierPaymentApplications.reversedAt),
					),
				);
		return evidenceOne(tx, payment.id);
	});
}

export async function assertOpeningHistory(
	db: Db,
	input: { invoiceId: number; paidCents: number; note?: string | null },
	actor: Actor,
) {
	if (wholeCents(input.paidCents, "Paid before") < 0)
		throw new MoneyError("Paid before can't be negative");
	return db.transaction(async (tx) => {
		const [header] = await tx
			.select()
			.from(supplierInvoices)
			.where(eq(supplierInvoices.id, input.invoiceId));
		if (!header) throw new PayableError(`No invoice ${input.invoiceId}`);
		await lockSupplier(tx, header.supplierId);
		const room = await invoiceRoom(tx, header.id);
		if (!room.legacy)
			throw new PayableError(`Invoice ${header.number} was recorded here, so its payments are known`);
		if (room.openingCents !== null) {
			if (room.openingCents === input.paidCents) return billingOf(tx, header.purchaseOrderId);
			throw new PayableError(`Invoice ${header.number} already has its history; withdraw it first`);
		}
		if (input.paidCents > room.openCents)
			throw new MoneyError(`Invoice ${header.number} has only $${(room.openCents / 100).toFixed(2)} open`);
		await tx.insert(supplierInvoiceOpenings).values({
			invoiceId: header.id,
			paidCents: input.paidCents,
			note: input.note?.trim() || null,
			assertedBy: recordedBy(actor),
		});
		return billingOf(tx, header.purchaseOrderId);
	});
}

export async function withdrawOpeningHistory(
	db: Db,
	input: { invoiceId: number },
	actor: Actor,
) {
	return db.transaction(async (tx) => {
		const [header] = await tx
			.select()
			.from(supplierInvoices)
			.where(eq(supplierInvoices.id, input.invoiceId));
		if (!header) throw new PayableError(`No invoice ${input.invoiceId}`);
		await lockSupplier(tx, header.supplierId);
		await tx
			.update(supplierInvoiceOpenings)
			.set({ withdrawnAt: sql`now()`, withdrawnBy: recordedBy(actor) })
			.where(
				and(
					eq(supplierInvoiceOpenings.invoiceId, header.id),
					isNull(supplierInvoiceOpenings.withdrawnAt),
				),
			);
		return billingOf(tx, header.purchaseOrderId);
	});
}

export type PaymentApplication = {
	id: string;
	invoiceId: number;
	amountCents: number;
	appliedAt: Date;
	reversedAt: Date | null;
};

export type PaymentEvidence = {
	paymentId: string;
	supplierId: number;
	currency: Currency;
	amountCents: number;
	paidOn: string;
	method: PaymentMethod;
	reference: string | null;
	source: "staff_recorded";
	recorded: { by: string | null; at: Date };
	state:
		| { kind: "recorded" }
		| { kind: "reversed"; at: Date; by: string | null; reason: string | null };
	appliedCents: number;
	unappliedCents: number;
	applications: PaymentApplication[];
};

export type BankConfirmation = {
	paymentId: string;
	bankTransactionId: string;
	confirmedAt: Date;
};

export type PaymentProof =
	| { kind: "staff_recorded" }
	| { kind: "bank_confirmed"; bankTransactionId: string; confirmedAt: Date };

export function proofOf(
	evidence: Pick<PaymentEvidence, "paymentId">,
	confirmations: ReadonlyMap<string, BankConfirmation>,
): PaymentProof {
	const found = confirmations.get(evidence.paymentId);
	return found
		? {
				kind: "bank_confirmed",
				bankTransactionId: found.bankTransactionId,
				confirmedAt: found.confirmedAt,
			}
		: { kind: "staff_recorded" };
}

export async function paymentEvidence(
	db: Db,
	where: { paymentIds: string[] } | { supplierId: number },
): Promise<PaymentEvidence[]> {
	if ("paymentIds" in where && where.paymentIds.length === 0) return [];
	const payments = await db
		.select()
		.from(supplierPayments)
		.where(
			"paymentIds" in where
				? inArray(supplierPayments.id, where.paymentIds.map((id) => idOf(id, "Payment")))
				: eq(supplierPayments.supplierId, where.supplierId),
		)
		.orderBy(supplierPayments.paidOn, supplierPayments.recordedAt);
	if (payments.length === 0) return [];
	const applications = await db
		.select()
		.from(supplierPaymentApplications)
		.where(
			inArray(
				supplierPaymentApplications.paymentId,
				payments.map((p) => p.id),
			),
		)
		.orderBy(supplierPaymentApplications.appliedAt);
	return payments.map((p) => {
		const mine = applications.filter((a) => a.paymentId === p.id);
		const appliedCents = mine
			.filter((a) => a.reversedAt === null)
			.reduce((n, a) => n + a.amountCents, 0);
		return {
			paymentId: p.id,
			supplierId: p.supplierId,
			currency: CURRENCY,
			amountCents: p.amountCents,
			paidOn: p.paidOn,
			method: p.method,
			reference: p.reference,
			source: "staff_recorded",
			recorded: { by: p.recordedBy, at: p.recordedAt },
			state: p.reversedAt
				? { kind: "reversed", at: p.reversedAt, by: p.reversedBy, reason: p.reversalReason }
				: { kind: "recorded" },
			appliedCents,
			unappliedCents: p.reversedAt ? 0 : p.amountCents - appliedCents,
			applications: mine.map((a) => ({
				id: a.id,
				invoiceId: a.invoiceId,
				amountCents: a.amountCents,
				appliedAt: a.appliedAt,
				reversedAt: a.reversedAt,
			})),
		};
	});
}

async function evidenceOne(db: Db, paymentId: string) {
	const [evidence] = await paymentEvidence(db, { paymentIds: [paymentId] });
	return evidence;
}

export async function orderPayables(db: Db, purchaseOrderId: number) {
	const billing = await billingOf(db, purchaseOrderId);
	const [po] = await db
		.select({ supplierId: purchaseOrders.supplierId })
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, purchaseOrderId));
	const ids = new Set(billing.invoices.map((i) => i.id));
	const payments = await paymentEvidence(db, { supplierId: po.supplierId });
	return {
		supplierId: po.supplierId,
		billing,
		payments: payments.filter(
			(p) =>
				p.unappliedCents > 0 || p.applications.some((a) => ids.has(a.invoiceId)),
		),
		unappliedCents: payments.reduce((n, p) => n + p.unappliedCents, 0),
	};
}

export type OrderPayables = Awaited<ReturnType<typeof orderPayables>>;
