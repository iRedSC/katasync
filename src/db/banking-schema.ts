import { type SQL, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	check,
	date,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { payouts } from "./schema";

export type BankDateFormat = "ymd" | "mdy" | "dmy";

export type BankAmountMapping =
	| { kind: "signed"; column: string; positiveMeans: "in" | "out" }
	| { kind: "split"; moneyIn: string; moneyOut: string };

export type BankCsvMapping = {
	date: string;
	dateFormat: BankDateFormat;
	description: string;
	amount: BankAmountMapping;
	bankId: string | null;
	currency: string | null;
};

const cents = () => bigint({ mode: "number" });

const isCurrency = (column: SQL | AnyPgColumn) => sql`${column} ~ '^[A-Z]{3}$'`;

export const bankAccounts = pgTable(
	"bank_accounts",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		name: text().notNull().unique(),
		currency: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		check("bank_accounts_currency", isCurrency(t.currency)),
		check(
			"bank_accounts_name",
			sql`${t.name} = btrim(${t.name}) and length(${t.name}) between 1 and 80`,
		),
	],
);

export const bankImports = pgTable(
	"bank_imports",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		accountId: integer()
			.notNull()
			.references(() => bankAccounts.id),
		fileSha256: text().notNull(),
		fileName: text(),
		mapping: jsonb().$type<BankCsvMapping>().notNull(),
		rowCount: integer().notNull(),
		importedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("bank_imports_account_file").on(t.accountId, t.fileSha256),
		check("bank_imports_sha", sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
		check("bank_imports_row_count", sql`${t.rowCount} >= 0`),
	],
);

export const bankRowOutcome = pgEnum("bank_row_outcome", [
	"accepted",
	"invalid",
	"duplicate",
	"skipped",
]);

export const bankImportRows = pgTable(
	"bank_import_rows",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		importId: integer()
			.notNull()
			.references(() => bankImports.id),
		rowNumber: integer().notNull(),
		cells: jsonb().$type<string[]>().notNull(),
		outcome: bankRowOutcome().notNull(),
		problem: text(),
		duplicateOf: integer().references((): AnyPgColumn => bankTransactions.id),
	},
	(t) => [
		unique("bank_import_rows_import_row").on(t.importId, t.rowNumber),
		check(
			"bank_import_rows_problem",
			sql`(${t.outcome} = 'invalid') = (${t.problem} is not null)`,
		),
		check(
			"bank_import_rows_duplicate",
			sql`(${t.outcome} = 'duplicate') = (${t.duplicateOf} is not null)`,
		),
	],
);

export const bankTransactions = pgTable(
	"bank_transactions",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		accountId: integer()
			.notNull()
			.references(() => bankAccounts.id),
		importRowId: integer()
			.notNull()
			.unique()
			.references(() => bankImportRows.id),
		postedOn: date({ mode: "string" }).notNull(),
		description: text().notNull(),
		amountCents: cents().notNull(),
		currency: text().notNull(),
		bankRef: text(),
		fingerprint: text().notNull(),
	},
	(t) => [
		unique("bank_transactions_account_ref").on(t.accountId, t.bankRef),
		index("bank_transactions_account_posted_idx").on(t.accountId, t.postedOn),
		index("bank_transactions_fingerprint_idx").on(t.accountId, t.fingerprint),
		check("bank_transactions_amount", sql`${t.amountCents} <> 0`),
		check(
			"bank_transactions_amount_bound",
			sql`abs(${t.amountCents}) < 1000000000000`,
		),
		check("bank_transactions_currency", isCurrency(t.currency)),
	],
);

export const bankTargetKind = pgEnum("bank_target_kind", ["payout"]);

export const bankMatches = pgTable(
	"bank_matches",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		transactionId: integer()
			.notNull()
			.references(() => bankTransactions.id),
		matchedAt: timestamp({ withTimezone: true })
			.notNull()
			.default(sql`clock_timestamp()`),
		undoneAt: timestamp({ withTimezone: true }),
		replaces: integer().references((): AnyPgColumn => bankMatches.id),
	},
	(t) => [
		uniqueIndex("bank_matches_active_transaction")
			.on(t.transactionId)
			.where(sql`${t.undoneAt} is null`),
		uniqueIndex("bank_matches_replaces").on(t.replaces),
		check(
			"bank_matches_undone_after",
			sql`${t.undoneAt} is null or ${t.undoneAt} >= ${t.matchedAt}`,
		),
	],
);

export const bankMatchParts = pgTable(
	"bank_match_parts",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		matchId: integer()
			.notNull()
			.references(() => bankMatches.id),
		targetKind: bankTargetKind().notNull(),
		payoutId: integer().references(() => payouts.id),
		amountCents: cents().notNull(),
		observedAmountCents: cents().notNull(),
		observedCurrency: text().notNull(),
		observedStatus: text().notNull(),
		observedReference: text(),
		observedOn: date({ mode: "string" }).notNull(),
	},
	(t) => [
		unique("bank_match_parts_target").on(t.matchId, t.targetKind, t.payoutId),
		index("bank_match_parts_payout_idx").on(t.payoutId),
		check(
			"bank_match_parts_payout",
			sql`(${t.targetKind} = 'payout') = (${t.payoutId} is not null)`,
		),
		check("bank_match_parts_amount", sql`${t.amountCents} <> 0`),
		check(
			"bank_match_parts_within",
			sql`sign(${t.amountCents}) = sign(${t.observedAmountCents}) and abs(${t.amountCents}) <= abs(${t.observedAmountCents})`,
		),
		check("bank_match_parts_currency", isCurrency(t.observedCurrency)),
	],
);

export type BankTargetSnapshot = {
	amountCents: number;
	currency: string;
	status: string;
	reference: string | null;
};

export const bankTargetChanges = pgTable(
	"bank_target_changes",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		targetKind: bankTargetKind().notNull(),
		payoutId: integer().references(() => payouts.id),
		changedAt: timestamp({ withTimezone: true })
			.notNull()
			.default(sql`clock_timestamp()`),
		before: jsonb().$type<BankTargetSnapshot>().notNull(),
		after: jsonb().$type<BankTargetSnapshot>().notNull(),
	},
	(t) => [
		index("bank_target_changes_payout_idx").on(t.payoutId, t.changedAt),
		check(
			"bank_target_changes_payout",
			sql`(${t.targetKind} = 'payout') = (${t.payoutId} is not null)`,
		),
	],
);
