import {
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";

export const reportKind = pgEnum("report_kind", ["sales_tax_month"]);

export const reportSnapshots = pgTable(
	"report_snapshots",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		kind: reportKind().notNull(),
		period: text().notNull(),
		revision: integer().notNull(),
		asOf: timestamp({ withTimezone: true }).notNull(),
		schemaVersion: integer().notNull(),
		rendererVersion: integer().notNull(),
		currency: text().notNull(),
		timeZone: text().notNull(),
		source: text().notNull(),
		data: jsonb().notNull(),
		dataDigest: text().notNull(),
		digest: text().notNull(),
	},
	(t) => [
		unique("report_snapshots_revision").on(t.kind, t.period, t.revision),
		unique("report_snapshots_digest").on(t.digest),
		unique("report_snapshots_id_digest").on(t.id, t.digest),
		index("report_snapshots_period_idx").on(t.kind, t.period),
	],
);

export const reportArtifacts = pgTable(
	"report_artifacts",
	{
		snapshotId: integer()
			.notNull()
			.references(() => reportSnapshots.id),
		name: text().notNull(),
		mediaType: text().notNull(),
		content: text().notNull(),
		sha256: text().notNull(),
	},
	(t) => [primaryKey({ columns: [t.snapshotId, t.name] })],
);

export const reportHandoffs = pgTable(
	"report_handoffs",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		snapshotId: integer().notNull(),
		digest: text().notNull(),
		recipient: text().notNull(),
		note: text(),
		handedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		foreignKey({
			name: "report_handoffs_revision_fk",
			columns: [t.snapshotId, t.digest],
			foreignColumns: [reportSnapshots.id, reportSnapshots.digest],
		}),
		index("report_handoffs_snapshot_idx").on(t.snapshotId),
	],
);
