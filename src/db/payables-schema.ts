import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	date,
	foreignKey,
	index,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { purchaseOrderLines, supplierInvoices, suppliers } from "./schema";

const cents = () => bigint({ mode: "number" });
const at = () => timestamp({ withTimezone: true });

export const supplierInvoiceDocuments = pgTable(
	"supplier_invoice_documents",
	{
		invoiceId: integer()
			.primaryKey()
			.references(() => supplierInvoices.id),
		currency: text().notNull().default("USD"),
		freightCents: cents().notNull().default(0),
		taxCents: cents().notNull().default(0),
		recordedBy: text(),
		createdAt: at().notNull().defaultNow(),
		createdTx: text().notNull().default(sql`txid_current()::text`),
	},
	(t) => [
		check("supplier_invoice_documents_usd", sql`${t.currency} = 'USD'`),
		check(
			"supplier_invoice_documents_extras_not_negative",
			sql`${t.freightCents} >= 0 and ${t.taxCents} >= 0`,
		),
	],
);

export const supplierInvoiceLines = pgTable(
	"supplier_invoice_lines",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		invoiceId: integer()
			.notNull()
			.references(() => supplierInvoiceDocuments.invoiceId),
		position: integer().notNull(),
		kind: text({ enum: ["merchandise", "credit"] }).notNull(),
		sku: text(),
		supplierSku: text(),
		description: text(),
		poLineId: integer().references(() => purchaseOrderLines.id),
		unmatchedReason: text(),
		quantity: integer(),
		unit: text(),
		packSize: integer(),
		unitPrice: numeric({ precision: 12, scale: 4, mode: "number" }),
		amountCents: cents().notNull(),
	},
	(t) => [
		unique("supplier_invoice_lines_position").on(t.invoiceId, t.position),
		index("supplier_invoice_lines_po_line_idx").on(t.poLineId),
		check(
			"supplier_invoice_lines_kind",
			sql`${t.kind} in ('merchandise', 'credit')`,
		),
		check("supplier_invoice_lines_position_positive", sql`${t.position} > 0`),
		check(
			"supplier_invoice_lines_merchandise_shape",
			sql`(${t.kind} = 'merchandise') = (${t.quantity} is not null and ${t.unit} is not null and ${t.packSize} is not null and ${t.unitPrice} is not null)`,
		),
		check(
			"supplier_invoice_lines_matched_or_why",
			sql`${t.kind} = 'credit' or ((${t.poLineId} is null) <> (${t.unmatchedReason} is null))`,
		),
		check(
			"supplier_invoice_lines_credit_unmatched",
			sql`${t.kind} = 'merchandise' or (${t.poLineId} is null and ${t.unmatchedReason} is null)`,
		),
		check(
			"supplier_invoice_lines_amounts",
			sql`(${t.quantity} is null or ${t.quantity} >= 0) and (${t.packSize} is null or ${t.packSize} > 0) and (${t.unitPrice} is null or ${t.unitPrice} >= 0) and (case when ${t.kind} = 'credit' then ${t.amountCents} > 0 else ${t.amountCents} >= 0 end)`,
		),
	],
);

export const supplierInvoiceVoids = pgTable(
	"supplier_invoice_voids",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		invoiceId: integer()
			.notNull()
			.references(() => supplierInvoices.id),
		reason: text(),
		voidedBy: text(),
		voidedAt: at().notNull().defaultNow(),
		restoredBy: text(),
		restoredAt: at(),
	},
	(t) => [
		index("supplier_invoice_voids_invoice_idx").on(t.invoiceId),
		uniqueIndex("supplier_invoice_voids_open")
			.on(t.invoiceId)
			.where(sql`${t.restoredAt} is null`),
		check(
			"supplier_invoice_voids_restore_whole",
			sql`${t.restoredBy} is null or ${t.restoredAt} is not null`,
		),
		check(
			"supplier_invoice_voids_restored_after",
			sql`${t.restoredAt} is null or ${t.restoredAt} >= ${t.voidedAt}`,
		),
	],
);

export const supplierInvoiceOpenings = pgTable(
	"supplier_invoice_openings",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		invoiceId: integer()
			.notNull()
			.references(() => supplierInvoices.id),
		paidCents: cents().notNull(),
		note: text(),
		assertedBy: text(),
		assertedAt: at().notNull().defaultNow(),
		withdrawnBy: text(),
		withdrawnAt: at(),
	},
	(t) => [
		uniqueIndex("supplier_invoice_openings_active")
			.on(t.invoiceId)
			.where(sql`${t.withdrawnAt} is null`),
		check("supplier_invoice_openings_paid", sql`${t.paidCents} >= 0`),
		check(
			"supplier_invoice_openings_withdraw_whole",
			sql`${t.withdrawnBy} is null or ${t.withdrawnAt} is not null`,
		),
	],
);

export const paymentMethods = [
	"ach",
	"check",
	"card",
	"wire",
	"cash",
	"other",
] as const;

export const supplierPayments = pgTable(
	"supplier_payments",
	{
		id: uuid().primaryKey(),
		supplierId: integer()
			.notNull()
			.references(() => suppliers.id),
		currency: text().notNull().default("USD"),
		amountCents: cents().notNull(),
		paidOn: date({ mode: "string" }).notNull(),
		requestDigest: text().notNull(),
		method: text({ enum: paymentMethods }).notNull(),
		reference: text(),
		recordedBy: text(),
		recordedAt: at().notNull().defaultNow(),
		reversedBy: text(),
		reversedAt: at(),
		reversalReason: text(),
	},
	(t) => [
		index("supplier_payments_supplier_idx").on(t.supplierId),
		unique("supplier_payments_id_supplier").on(t.id, t.supplierId),
		check("supplier_payments_usd", sql`${t.currency} = 'USD'`),
		check("supplier_payments_positive", sql`${t.amountCents} > 0`),
		check(
			"supplier_payments_method",
			sql`${t.method} in ('ach', 'check', 'card', 'wire', 'cash', 'other')`,
		),
		check(
			"supplier_payments_reversal_whole",
			sql`(${t.reversedBy} is null and ${t.reversalReason} is null) or ${t.reversedAt} is not null`,
		),
	],
);

export const supplierPaymentApplications = pgTable(
	"supplier_payment_applications",
	{
		id: uuid().primaryKey(),
		paymentId: uuid().notNull(),
		supplierId: integer().notNull(),
		invoiceId: integer()
			.notNull()
			.references(() => supplierInvoices.id),
		amountCents: cents().notNull(),
		appliedBy: text(),
		appliedAt: at().notNull().defaultNow(),
		reversedBy: text(),
		reversedAt: at(),
	},
	(t) => [
		foreignKey({
			name: "supplier_payment_applications_payment_fk",
			columns: [t.paymentId, t.supplierId],
			foreignColumns: [supplierPayments.id, supplierPayments.supplierId],
		}),
		index("supplier_payment_applications_payment_idx").on(t.paymentId),
		index("supplier_payment_applications_invoice_idx").on(t.invoiceId),
		check("supplier_payment_applications_positive", sql`${t.amountCents} > 0`),
		check(
			"supplier_payment_applications_reversal_whole",
			sql`${t.reversedBy} is null or ${t.reversedAt} is not null`,
		),
	],
);
