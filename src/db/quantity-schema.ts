import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	smallint,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { locations, orderLines, orders, products, transfers } from "./schema";

export const quantityModeKind = pgEnum("quantity_mode_kind", [
	"legacy",
	"committed",
]);

export const quantityMode = pgTable(
	"quantity_mode",
	{
		id: smallint().primaryKey().default(1),
		mode: quantityModeKind().notNull().default("legacy"),
		activatedAt: timestamp({ withTimezone: true }),
		activationReport: jsonb(),
	},
	(t) => [
		check("quantity_mode_single", sql`${t.id} = 1`),
		check(
			"quantity_mode_activated",
			sql`(${t.mode} = 'committed') = (${t.activatedAt} is not null)`,
		),
	],
);

export const commitmentSource = pgEnum("commitment_source", [
	"order",
	"activation",
]);

export const stockCommitments = pgTable(
	"stock_commitments",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		orderLineId: integer()
			.notNull()
			.references(() => orderLines.id),
		orderId: integer()
			.notNull()
			.references(() => orders.id),
		revision: integer().notNull(),
		productId: integer()
			.notNull()
			.references(() => products.id),
		quantity: integer().notNull(),
		source: commitmentSource().notNull(),
		legacySaleBatchId: uuid(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("stock_commitments_line_revision").on(t.orderLineId, t.revision),
		check("stock_commitments_quantity", sql`${t.quantity} > 0`),
		check("stock_commitments_revision", sql`${t.revision} > 0`),
		check(
			"stock_commitments_legacy_source",
			sql`(${t.source} = 'activation') = (${t.legacySaleBatchId} is not null)`,
		),
		index("stock_commitments_order_idx").on(t.orderId),
	],
);

export const stockCommitmentParts = pgTable(
	"stock_commitment_parts",
	{
		commitmentId: integer()
			.notNull()
			.references(() => stockCommitments.id),
		productId: integer()
			.notNull()
			.references(() => products.id),
		perUnit: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.commitmentId, t.productId] }),
		check("stock_commitment_parts_per_unit", sql`${t.perUnit} > 0`),
		index("stock_commitment_parts_product_idx").on(t.productId),
	],
);

export const commitmentEntryKind = pgEnum("commitment_entry_kind", [
	"consume",
	"release",
	"restore",
]);

export const stockCommitmentEntries = pgTable(
	"stock_commitment_entries",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		commitmentId: integer()
			.notNull()
			.references(() => stockCommitments.id),
		kind: commitmentEntryKind().notNull(),
		quantity: integer().notNull(),
		fulfillmentKey: text(),
		batchId: uuid(),
		restoresEntryId: bigint({ mode: "number" }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("stock_commitment_entries_fulfillment").on(
			t.commitmentId,
			t.fulfillmentKey,
		),
		unique("stock_commitment_entries_restores").on(t.restoresEntryId),
		check("stock_commitment_entries_quantity", sql`${t.quantity} > 0`),
		check(
			"stock_commitment_entries_shape",
			sql`case ${t.kind}
				when 'consume' then ${t.fulfillmentKey} is not null and ${t.batchId} is not null and ${t.restoresEntryId} is null
				when 'release' then ${t.fulfillmentKey} is null and ${t.batchId} is null and ${t.restoresEntryId} is null
				else ${t.fulfillmentKey} is null and ${t.batchId} is not null and ${t.restoresEntryId} is not null
			end`,
		),
		index("stock_commitment_entries_commitment_idx").on(t.commitmentId),
		index("stock_commitment_entries_key_idx").on(t.fulfillmentKey),
	],
);

export const shipmentEvidenceKind = pgEnum("shipment_evidence_kind", [
	"shipped",
	"voided",
]);

export const unreservedShipments = pgTable(
	"unreserved_shipments",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		orderLineId: integer()
			.notNull()
			.references(() => orderLines.id),
		orderId: integer()
			.notNull()
			.references(() => orders.id),
		kind: shipmentEvidenceKind().notNull(),
		fulfillmentKey: text().notNull(),
		quantity: integer().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("unreserved_shipments_once").on(
			t.orderLineId,
			t.fulfillmentKey,
			t.kind,
		),
		check("unreserved_shipments_quantity", sql`${t.quantity} > 0`),
		index("unreserved_shipments_order_idx").on(t.orderId),
	],
);

export const committedStock = pgTable(
	"committed_stock",
	{
		productId: integer()
			.primaryKey()
			.references(() => products.id),
		units: integer().notNull().default(0),
	},
	(t) => [check("committed_stock_units", sql`${t.units} >= 0`)],
);

export const transferDispatches = pgTable(
	"transfer_dispatches",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		transferId: integer()
			.notNull()
			.references(() => transfers.id),
		batchId: uuid().notNull().unique(),
		transitLocationId: integer()
			.notNull()
			.references(() => locations.id),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("transfer_dispatches_transfer_idx").on(t.transferId)],
);

export const transferDispatchLines = pgTable(
	"transfer_dispatch_lines",
	{
		dispatchId: integer()
			.notNull()
			.references(() => transferDispatches.id),
		productId: integer()
			.notNull()
			.references(() => products.id),
		quantity: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.dispatchId, t.productId] }),
		check("transfer_dispatch_lines_quantity", sql`${t.quantity} > 0`),
	],
);

export const transferReceipts = pgTable(
	"transfer_receipts",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		dispatchId: integer()
			.notNull()
			.references(() => transferDispatches.id),
		receiptKey: text().notNull(),
		batchId: uuid().notNull().unique(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("transfer_receipts_key").on(t.dispatchId, t.receiptKey),
		index("transfer_receipts_dispatch_idx").on(t.dispatchId),
	],
);

export const transferReceiptLines = pgTable(
	"transfer_receipt_lines",
	{
		receiptId: integer()
			.notNull()
			.references(() => transferReceipts.id),
		productId: integer()
			.notNull()
			.references(() => products.id),
		quantity: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.receiptId, t.productId] }),
		check("transfer_receipt_lines_quantity", sql`${t.quantity} > 0`),
	],
);
