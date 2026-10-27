import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
	bankImportRows,
	bankImports,
	bankTransactions,
} from "#/db/banking-schema";
import type { Db } from "#/db/client";
import {
	type AccountView,
	listAccounts,
	loadAccount,
	viewOf,
} from "./accounts";
import { remainingOf, type Standing } from "./allocate";
import { daysBetween } from "./dates";
import { standingOf } from "./matching";
import {
	type BankState,
	bankStateOf,
	type MatchState,
	matchStates,
	reviewingTargets,
} from "./review";
import { type Suggestions, suggest, usable, WINDOW_DAYS } from "./suggest";
import { NEAR_LIMIT, payoutTarget } from "./targets";

export const ROW_LIMIT = 1000;

const shift = (day: string, days: number) =>
	new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);

const transactionFields = {
	id: bankTransactions.id,
	postedOn: bankTransactions.postedOn,
	description: bankTransactions.description,
	amountCents: bankTransactions.amountCents,
	currency: bankTransactions.currency,
	bankRef: bankTransactions.bankRef,
	fingerprint: bankTransactions.fingerprint,
	importId: bankImportRows.importId,
	rowNumber: bankImportRows.rowNumber,
};

export type BankRowView = {
	id: number;
	postedOn: string;
	description: string;
	amountCents: number;
	bankRef: string | null;
	importId: number;
	rowNumber: number;
	possibleRepeat: boolean;
	pastMatches: number;
	state: MatchState;
};

export type PayoutView = Standing & { bank: BankState };

export type ImportView = {
	id: number;
	fileName: string | null;
	importedAt: string;
	counts: Record<"accepted" | "invalid" | "duplicate" | "skipped", number>;
};

export type Overview = {
	accounts: AccountView[];
	account: AccountView | null;
	rows: BankRowView[];
	truncated: boolean;
	payouts: PayoutView[];
	// How many payouts were read when more were near the rows; null when
	// none were left out.
	payoutsCut: number | null;
	imports: ImportView[];
};

async function repeatedPrints(db: Db, accountId: number, prints: string[]) {
	if (prints.length === 0) return new Set<string>();
	const found = await db
		.select({ fingerprint: bankTransactions.fingerprint })
		.from(bankTransactions)
		.innerJoin(
			bankImportRows,
			eq(bankImportRows.id, bankTransactions.importRowId),
		)
		.where(
			and(
				eq(bankTransactions.accountId, accountId),
				isNull(bankTransactions.voidedAt),
				isNull(bankTransactions.bankRef),
				inArray(bankTransactions.fingerprint, prints),
			),
		)
		.groupBy(bankTransactions.fingerprint)
		.having(sql`count(distinct ${bankImportRows.importId}) > 1`);
	return new Set(found.map((f) => f.fingerprint));
}

async function importsOf(db: Db, accountId: number): Promise<ImportView[]> {
	const rows = await db
		.select({
			id: bankImports.id,
			fileName: bankImports.fileName,
			importedAt: bankImports.importedAt,
			outcome: bankImportRows.outcome,
			n: sql<number>`count(${bankImportRows.id})::int`,
		})
		.from(bankImports)
		.leftJoin(bankImportRows, eq(bankImportRows.importId, bankImports.id))
		.where(eq(bankImports.accountId, accountId))
		.groupBy(bankImports.id, bankImportRows.outcome)
		.orderBy(desc(bankImports.id));
	const out = new Map<number, ImportView>();
	for (const r of rows) {
		const view = out.get(r.id) ?? {
			id: r.id,
			fileName: r.fileName,
			importedAt: r.importedAt.toISOString(),
			counts: { accepted: 0, invalid: 0, duplicate: 0, skipped: 0 },
		};
		if (r.outcome) view.counts[r.outcome] = r.n;
		out.set(r.id, view);
	}
	return [...out.values()];
}

export async function loadOverview(
	db: Db,
	accountId: number | null,
): Promise<Overview> {
	return db.transaction((tx) => readOverview(tx, accountId), {
		isolationLevel: "repeatable read",
		accessMode: "read only",
	});
}

async function readOverview(
	db: Db,
	accountId: number | null,
): Promise<Overview> {
	const accounts: AccountView[] = (await listAccounts(db)).map(viewOf);
	const account =
		accountId === null
			? (accounts[0] ?? null)
			: accounts.find((account) => account.id === accountId);
	if (account === undefined) throw new Error("That bank account doesn't exist");
	if (!account)
		return {
			accounts,
			account,
			rows: [],
			truncated: false,
			payouts: [],
			payoutsCut: null,
			imports: [],
		};
	const found = await db
		.select(transactionFields)
		.from(bankTransactions)
		.innerJoin(
			bankImportRows,
			eq(bankImportRows.id, bankTransactions.importRowId),
		)
		.where(
			and(
				eq(bankTransactions.accountId, account.id),
				isNull(bankTransactions.voidedAt),
			),
		)
		.orderBy(desc(bankTransactions.postedOn), desc(bankTransactions.id))
		.limit(ROW_LIMIT + 1);
	const truncated = found.length > ROW_LIMIT;
	const txns = found.slice(0, ROW_LIMIT);
	const repeated = await repeatedPrints(db, account.id, [
		...new Set(
			txns.filter((t) => t.bankRef === null).map((t) => t.fingerprint),
		),
	]);
	const evidence = await matchStates(
		db,
		txns.map((t) => t.id),
		account.currency,
	);
	const rows = txns.map(
		(t): BankRowView => ({
			id: t.id,
			postedOn: t.postedOn,
			description: t.description,
			amountCents: t.amountCents,
			bankRef: t.bankRef,
			importId: t.importId,
			rowNumber: t.rowNumber,
			possibleRepeat: t.bankRef === null && repeated.has(t.fingerprint),
			pastMatches: evidence.pastMatches.get(t.id) ?? 0,
			state: evidence.states.get(t.id) ?? { kind: "unmatched" },
		}),
	);
	const days = txns.map((t) => t.postedOn).sort();
	const near =
		days.length === 0
			? { observed: [], truncated: false }
			: await payoutTarget.near(
					db,
					{
						currency: account.currency,
						from: shift(days[0], -WINDOW_DAYS.before),
						to: shift(days[days.length - 1], WINDOW_DAYS.after),
					},
					"all",
				);
	const standing = await standingOf(
		db,
		near.observed.map((p) => p.ref),
		{ lock: false, excludeMatch: null },
	);
	for (const [key, t] of evidence.targets)
		if (t.currency === account.currency) standing.set(key, t);
	const reviewing = await reviewingTargets(
		db,
		[...standing.values()].map((target) => target.ref),
		account.currency,
	);
	const payouts = [...standing.values()]
		.sort((a, b) => b.on.localeCompare(a.on))
		.map((t) => ({ ...t, bank: bankStateOf(t, reviewing) }));
	return {
		accounts,
		account,
		rows,
		truncated,
		payouts,
		payoutsCut: near.truncated ? NEAR_LIMIT : null,
		imports: await importsOf(db, account.id),
	};
}

export type MatchOptions = {
	bank: {
		id: number;
		amountCents: number;
		currency: string;
		postedOn: string;
		description: string;
	};
	candidates: (Standing & { days: number; remainingCents: number })[];
} & Suggestions;

export async function matchOptions(
	db: Db,
	transactionId: number,
): Promise<MatchOptions | null> {
	const [bank] = await db
		.select({
			id: bankTransactions.id,
			accountId: bankTransactions.accountId,
			amountCents: bankTransactions.amountCents,
			currency: bankTransactions.currency,
			postedOn: bankTransactions.postedOn,
			description: bankTransactions.description,
		})
		.from(bankTransactions)
		.where(
			and(
				eq(bankTransactions.id, transactionId),
				isNull(bankTransactions.voidedAt),
			),
		);
	if (!bank || !(await loadAccount(db, bank.accountId))) return null;
	// Only payouts with some left to match: matched ones can't be picked, and
	// mustn't push open ones past the limit.
	const near = await payoutTarget.near(
		db,
		{
			currency: bank.currency,
			from: shift(bank.postedOn, -WINDOW_DAYS.before),
			to: shift(bank.postedOn, WINDOW_DAYS.after),
		},
		"open",
	);
	const standing = [
		...(
			await standingOf(
				db,
				near.observed.map((p) => p.ref),
				{ lock: false, excludeMatch: null },
			)
		).values(),
	];
	const candidates = standing
		.filter((t) => usable(bank, t))
		.map((t) => ({
			...t,
			days: daysBetween(t.on, bank.postedOn),
			remainingCents: remainingOf(t),
		}))
		.sort((a, b) => Math.abs(a.days) - Math.abs(b.days));
	const shown = {
		id: bank.id,
		amountCents: bank.amountCents,
		currency: bank.currency,
		postedOn: bank.postedOn,
		description: bank.description,
	};
	return { bank: shown, candidates, ...suggest(bank, standing) };
}
