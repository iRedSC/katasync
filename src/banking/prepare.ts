import { createHash } from "node:crypto";
import type { BankCsvMapping } from "#/db/banking-schema";
import { LIMITS, readCsv } from "./csv";
import { parseBankDate } from "./dates";
import { type Columns, resolveMapping } from "./mapping";
import {
	type Currency,
	clip,
	type Parsed,
	parseCents,
	parseCurrency,
} from "./money";

export type ParsedTransaction = {
	postedOn: string;
	description: string;
	amountCents: number;
	bankRef: string | null;
	fingerprint: string;
};

export type PreparedRow = {
	rowNumber: number;
	cells: string[];
} & (
	| { kind: "accepted"; transaction: ParsedTransaction; twinOf: number | null }
	| { kind: "invalid"; problem: string }
);

export type PreparedFile = {
	sha256: string;
	headers: string[];
	rows: PreparedRow[];
};

export const sha256 = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

export function fingerprintOf(
	t: Omit<ParsedTransaction, "fingerprint" | "bankRef">,
) {
	const description = t.description.replace(/\s+/g, " ").toLowerCase();
	return sha256(`${t.postedOn}\u0000${t.amountCents}\u0000${description}`);
}

function amountOf(cells: string[], amount: Columns["amount"]): Parsed<number> {
	if (amount.kind === "signed") {
		const parsed = parseCents(cells[amount.column] ?? "");
		if (!parsed.ok) return parsed;
		return {
			ok: true,
			value: amount.positiveMeans === "in" ? parsed.value : -parsed.value,
		};
	}
	const inText = (cells[amount.moneyIn] ?? "").trim();
	const outText = (cells[amount.moneyOut] ?? "").trim();
	if (inText !== "" && outText !== "")
		return { ok: false, problem: "Both money in and money out are filled" };
	if (inText === "" && outText === "")
		return { ok: false, problem: "Neither money in nor money out is filled" };
	const parsed = parseCents(inText || outText);
	if (!parsed.ok) return parsed;
	if (parsed.value < 0)
		return {
			ok: false,
			problem: `Money ${inText ? "in" : "out"} is negative; its column should hold the size only`,
		};
	return { ok: true, value: inText ? parsed.value : -parsed.value };
}

function parseRow(
	cells: string[],
	columns: Columns,
	width: number,
	mapping: BankCsvMapping,
	currency: Currency,
): Parsed<ParsedTransaction> {
	if (cells.length !== width)
		return {
			ok: false,
			problem: `Has ${cells.length} cells; the header has ${width}`,
		};
	if (cells.some((c) => c.length > LIMITS.cellLength))
		return { ok: false, problem: "A cell is too long" };
	const postedOn = parseBankDate(cells[columns.date], mapping.dateFormat);
	if (!postedOn.ok) return postedOn;
	const amount = amountOf(cells, columns.amount);
	if (!amount.ok) return amount;
	if (amount.value === 0) return { ok: false, problem: "Amount is zero" };
	if (columns.currency !== null) {
		const raw = cells[columns.currency];
		const rowCurrency = parseCurrency(raw);
		if (!rowCurrency.ok) return rowCurrency;
		if (rowCurrency.value !== currency)
			return {
				ok: false,
				problem: `Row is in ${rowCurrency.value}; the account is ${currency}, and conversion isn't supported`,
			};
	}
	const description = cells[columns.description].trim();
	const ref = columns.bankId === null ? "" : cells[columns.bankId].trim();
	if (ref.length > 200) return { ok: false, problem: "Bank ID is too long" };
	const base = {
		postedOn: postedOn.value,
		description,
		amountCents: amount.value,
	};
	return {
		ok: true,
		value: { ...base, bankRef: ref || null, fingerprint: fingerprintOf(base) },
	};
}

export function prepareFile(
	text: string,
	mapping: BankCsvMapping,
	currency: Currency,
): Parsed<PreparedFile> {
	const table = readCsv(text);
	if (!table.ok) return table;
	const columns = resolveMapping(table.value.headers, mapping);
	if (!columns.ok) return columns;
	const width = table.value.headers.length;
	const refs = new Map<string, number>();
	const prints = new Map<string, number>();
	const rows = table.value.rows.map((cells, i): PreparedRow => {
		const rowNumber = i + 1;
		const parsed = parseRow(cells, columns.value, width, mapping, currency);
		if (!parsed.ok)
			return { rowNumber, cells, kind: "invalid", problem: parsed.problem };
		const t = parsed.value;
		if (t.bankRef !== null) {
			const earlier = refs.get(t.bankRef);
			if (earlier !== undefined)
				return {
					rowNumber,
					cells,
					kind: "invalid",
					problem: `Bank ID "${clip(t.bankRef)}" repeats row ${earlier}`,
				};
			refs.set(t.bankRef, rowNumber);
		}
		const twinOf =
			t.bankRef === null ? (prints.get(t.fingerprint) ?? null) : null;
		if (t.bankRef === null && twinOf === null)
			prints.set(t.fingerprint, rowNumber);
		return { rowNumber, cells, kind: "accepted", transaction: t, twinOf };
	});
	return {
		ok: true,
		value: { sha256: sha256(text), headers: table.value.headers, rows },
	};
}
