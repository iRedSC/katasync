import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordedBy } from "#/audit/recorded-by";
import type { Actor } from "#/auth/actor";
import {
	type BankCsvMapping,
	bankImportRows,
	bankImports,
	bankMatches,
	bankTransactions,
} from "#/db/banking-schema";
import type { Db } from "#/db/client";
import { type Account, loadAccount } from "./accounts";
import { formatCents, type Parsed } from "./money";
import { type ParsedTransaction, prepareFile } from "./prepare";

export type PreviewRow =
	| {
			kind: "accepted";
			rowNumber: number;
			transaction: ParsedTransaction;
			twinOf: number | null;
			repeatOf: number | null;
	  }
	| {
			kind: "duplicate";
			rowNumber: number;
			transaction: ParsedTransaction;
			duplicateOf: number;
	  }
	| { kind: "invalid"; rowNumber: number; cells: string[]; problem: string };

export type Preview = {
	sha256: string;
	headers: string[];
	alreadyImported: number | null;
	rows: PreviewRow[];
};

type Classified = Preview & { cells: Map<number, string[]> };

export type ImportInput = {
	accountId: number;
	text: string;
	fileName: string | null;
	mapping: BankCsvMapping;
	replacesImportId?: number;
};

const CHUNK = 1000;

function chunks<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += CHUNK)
		out.push(items.slice(i, i + CHUNK));
	return out;
}

async function classify(
	db: Db,
	account: Account,
	input: ImportInput,
): Promise<Parsed<Classified>> {
	const prepared = prepareFile(input.text, input.mapping, account.currency);
	if (!prepared.ok) return prepared;
	const { rows, sha256, headers } = prepared.value;
	const [already] = await db
		.select({ id: bankImports.id })
		.from(bankImports)
		.where(
			and(
				eq(bankImports.accountId, account.id),
				eq(bankImports.fileSha256, sha256),
				isNull(bankImports.voidedAt),
			),
		);
	const accepted = rows.flatMap((r) =>
		r.kind === "accepted" ? [r.transaction] : [],
	);
	const refs = accepted.flatMap((t) => (t.bankRef === null ? [] : [t.bankRef]));
	const prints = [
		...new Set(
			accepted.filter((t) => t.bankRef === null).map((t) => t.fingerprint),
		),
	];
	const known = new Map<
		string,
		{ id: number; postedOn: string; amountCents: number }
	>();
	for (const part of chunks(refs)) {
		const found = await db
			.select({
				id: bankTransactions.id,
				bankRef: bankTransactions.bankRef,
				postedOn: bankTransactions.postedOn,
				amountCents: bankTransactions.amountCents,
			})
			.from(bankTransactions)
			.where(
				and(
					eq(bankTransactions.accountId, account.id),
					isNull(bankTransactions.voidedAt),
					sql`not exists (select 1 from bank_import_rows old where old.id = ${bankTransactions.importRowId} and old.import_id = ${input.replacesImportId ?? null})`,
					inArray(bankTransactions.bankRef, part),
				),
			);
		for (const f of found) if (f.bankRef !== null) known.set(f.bankRef, f);
	}
	const earlier = new Map<string, number[]>();
	for (const part of chunks(prints)) {
		const found = await db
			.select({
				id: bankTransactions.id,
				fingerprint: bankTransactions.fingerprint,
			})
			.from(bankTransactions)
			.where(
				and(
					eq(bankTransactions.accountId, account.id),
					isNull(bankTransactions.voidedAt),
					sql`not exists (select 1 from bank_import_rows old where old.id = ${bankTransactions.importRowId} and old.import_id = ${input.replacesImportId ?? null})`,
					isNull(bankTransactions.bankRef),
					inArray(bankTransactions.fingerprint, part),
				),
			)
			.orderBy(asc(bankTransactions.id));
		for (const f of found)
			earlier.set(f.fingerprint, [...(earlier.get(f.fingerprint) ?? []), f.id]);
	}
	const seen = new Map<string, number>();
	const cells = new Map(rows.map((r) => [r.rowNumber, r.cells]));
	const out = rows.map((r): PreviewRow => {
		if (r.kind === "invalid")
			return {
				kind: "invalid",
				rowNumber: r.rowNumber,
				cells: r.cells,
				problem: r.problem,
			};
		const t = r.transaction;
		if (t.bankRef !== null) {
			const prior = known.get(t.bankRef);
			if (!prior)
				return {
					kind: "accepted",
					rowNumber: r.rowNumber,
					transaction: t,
					twinOf: null,
					repeatOf: null,
				};
			if (prior.postedOn === t.postedOn && prior.amountCents === t.amountCents)
				return {
					kind: "duplicate",
					rowNumber: r.rowNumber,
					transaction: t,
					duplicateOf: prior.id,
				};
			return {
				kind: "invalid",
				rowNumber: r.rowNumber,
				cells: r.cells,
				problem: `Bank ID ${t.bankRef} was imported before as ${prior.postedOn}, ${formatCents(prior.amountCents, account.currency)}`,
			};
		}
		const nth = seen.get(t.fingerprint) ?? 0;
		seen.set(t.fingerprint, nth + 1);
		return {
			kind: "accepted",
			rowNumber: r.rowNumber,
			transaction: t,
			twinOf: r.twinOf,
			repeatOf: earlier.get(t.fingerprint)?.[nth] ?? null,
		};
	});
	return {
		ok: true,
		value: {
			sha256,
			headers,
			alreadyImported:
				already?.id === input.replacesImportId ? null : (already?.id ?? null),
			rows: out,
			cells,
		},
	};
}

export async function previewImport(
	db: Db,
	input: ImportInput,
): Promise<Parsed<Preview>> {
	const account = await loadAccount(db, input.accountId);
	if (!account)
		return { ok: false, problem: "That bank account doesn't exist" };
	const classified = await classify(db, account, input);
	if (!classified.ok) return classified;
	const { sha256, headers, alreadyImported, rows } = classified.value;
	return { ok: true, value: { sha256, headers, alreadyImported, rows } };
}

export type Committed =
	| { kind: "already"; importId: number }
	| {
			kind: "imported";
			importId: number;
			added: number;
			skipped: number;
			duplicates: number;
			invalid: number;
	  };

export async function commitImport(
	db: Db,
	input: ImportInput & {
		skipRows: readonly number[];
		keepRows?: readonly number[];
	},
	actor: Actor,
): Promise<Parsed<Committed>> {
	return db.transaction(async (tx) => {
		const account = await loadAccount(tx, input.accountId, { lock: true });
		if (!account)
			return { ok: false, problem: "That bank account doesn't exist" };
		const preview = await classify(tx, account, input);
		if (!preview.ok) return preview;
		const p = preview.value;
		const mapping = input.mapping;
		const requestDigest = createHash("sha256")
			.update(
				JSON.stringify([
					mapping.date,
					mapping.dateFormat,
					mapping.description,
					mapping.bankId,
					mapping.currency,
					mapping.amount.kind === "signed"
						? ["signed", mapping.amount.column, mapping.amount.positiveMeans]
						: ["split", mapping.amount.moneyIn, mapping.amount.moneyOut],
					[...new Set(input.skipRows)].sort((first, second) => first - second),
					[...new Set(input.keepRows ?? [])].sort(
						(first, second) => first - second,
					),
					input.replacesImportId ?? null,
				]),
			)
			.digest("hex");
		const [replay] = await tx
			.select()
			.from(bankImports)
			.where(
				and(
					eq(bankImports.accountId, account.id),
					eq(bankImports.fileSha256, p.sha256),
					input.replacesImportId === undefined
						? isNull(bankImports.replacesImportId)
						: eq(bankImports.replacesImportId, input.replacesImportId),
				),
			);
		if (replay)
			return replay.requestDigest === requestDigest
				? { ok: true, value: { kind: "already", importId: replay.id } }
				: {
						ok: false,
						problem:
							"This file was imported with different choices. Use Correct import.",
					};
		const skip = new Set(input.skipRows);
		const keep = new Set(input.keepRows ?? []);
		const skippable = new Set(
			p.rows.flatMap((r) => (r.kind === "accepted" ? [r.rowNumber] : [])),
		);
		for (const n of skip)
			if (!skippable.has(n))
				return {
					ok: false,
					problem: `Row ${n} isn't one that can be left out`,
				};
		for (const row of p.rows) {
			if (
				row.kind === "accepted" &&
				row.repeatOf !== null &&
				skip.has(row.rowNumber) === keep.has(row.rowNumber)
			)
				return {
					ok: false,
					problem: `Row ${row.rowNumber} may already be imported. Choose New transaction or Leave out.`,
				};
		}
		if (input.replacesImportId !== undefined) {
			const [previous] = await tx
				.select()
				.from(bankImports)
				.where(
					and(
						eq(bankImports.id, input.replacesImportId),
						eq(bankImports.accountId, account.id),
						eq(bankImports.fileSha256, p.sha256),
						isNull(bankImports.voidedAt),
					),
				);
			if (!previous)
				return {
					ok: false,
					problem:
						"That import has already been corrected or is a different file",
				};
			const previousRows = await tx
				.select({ id: bankTransactions.id })
				.from(bankTransactions)
				.innerJoin(
					bankImportRows,
					eq(bankImportRows.id, bankTransactions.importRowId),
				)
				.where(eq(bankImportRows.importId, previous.id))
				.for("update", { of: bankTransactions });
			const ids = previousRows.map((row) => row.id);
			if (ids.length > 0) {
				const [matched] = await tx
					.select({ id: bankMatches.id })
					.from(bankMatches)
					.where(
						and(
							inArray(bankMatches.transactionId, ids),
							isNull(bankMatches.undoneAt),
						),
					)
					.limit(1);
				if (matched)
					return {
						ok: false,
						problem: "Undo this import's payout matches before correcting it",
					};
				await tx
					.update(bankTransactions)
					.set({
						voidedAt: sql`clock_timestamp()`,
						voidedBy: recordedBy(actor),
					})
					.where(inArray(bankTransactions.id, ids));
			}
			await tx
				.update(bankImports)
				.set({ voidedAt: sql`clock_timestamp()`, voidedBy: recordedBy(actor) })
				.where(eq(bankImports.id, previous.id));
		}
		const [made] = await tx
			.insert(bankImports)
			.values({
				accountId: account.id,
				fileSha256: p.sha256,
				fileName: input.fileName?.slice(0, 200) || null,
				mapping: input.mapping,
				rowCount: p.rows.length,
				importedBy: recordedBy(actor),
				requestDigest,
				replacesImportId: input.replacesImportId ?? null,
			})
			.returning({ id: bankImports.id });
		const outcomeOf = (
			r: PreviewRow,
		): typeof bankImportRows.$inferInsert.outcome =>
			r.kind === "accepted"
				? skip.has(r.rowNumber)
					? "skipped"
					: "accepted"
				: r.kind;
		const rowIds = new Map<number, number>();
		for (const part of chunks(p.rows)) {
			const ids = await tx
				.insert(bankImportRows)
				.values(
					part.map((r) => ({
						importId: made.id,
						rowNumber: r.rowNumber,
						cells: p.cells.get(r.rowNumber) ?? [],
						outcome: outcomeOf(r),
						problem: r.kind === "invalid" ? r.problem : null,
						duplicateOf: r.kind === "duplicate" ? r.duplicateOf : null,
					})),
				)
				.returning({
					id: bankImportRows.id,
					rowNumber: bankImportRows.rowNumber,
				});
			for (const row of ids) rowIds.set(row.rowNumber, row.id);
		}
		const adding = p.rows.flatMap((r) =>
			r.kind === "accepted" && !skip.has(r.rowNumber) ? [r] : [],
		);
		for (const part of chunks(adding))
			await tx.insert(bankTransactions).values(
				part.map((r) => {
					const importRowId = rowIds.get(r.rowNumber);
					if (importRowId === undefined)
						throw new Error(`Row ${r.rowNumber} wasn't saved`);
					return {
						accountId: account.id,
						importRowId,
						currency: account.currency,
						...r.transaction,
					};
				}),
			);
		const count = (kind: PreviewRow["kind"]) =>
			p.rows.filter((r) => r.kind === kind).length;
		return {
			ok: true,
			value: {
				kind: "imported",
				importId: made.id,
				added: adding.length,
				skipped: skip.size,
				duplicates: count("duplicate"),
				invalid: count("invalid"),
			},
		};
	});
}
