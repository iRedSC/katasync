import type { BankCsvMapping, BankDateFormat } from "#/db/banking-schema";
import { readCsv } from "./csv";
import type { Parsed } from "./money";

export type Peek = { headers: string[]; sample: string[][]; rowCount: number; guess: BankCsvMapping };

const pick = (headers: readonly string[], pattern: RegExp, taken: Set<string>) => {
	const found = headers.find((h) => !taken.has(h) && pattern.test(h));
	if (found) taken.add(found);
	return found ?? null;
};

export function guessDateFormat(values: readonly string[]): BankDateFormat {
	const parts = values.map((v) => v.trim().split(/[-/.]/));
	if (parts.some((p) => p[0]?.length === 4)) return "ymd";
	if (parts.some((p) => Number(p[0]) > 12)) return "dmy";
	return "mdy";
}

export function peekFile(text: string): Parsed<Peek> {
	const table = readCsv(text);
	if (!table.ok) return table;
	const { headers, rows } = table.value;
	const taken = new Set<string>();
	const date = pick(headers, /date|posted/i, taken) ?? headers[0];
	taken.add(date);
	const description = pick(headers, /desc|memo|payee|details|narrative|name/i, taken) ?? headers[1] ?? headers[0];
	taken.add(description);
	const moneyIn = pick(headers, /credit|deposit|money in|paid in/i, taken);
	const moneyOut = pick(headers, /debit|withdraw|money out|paid out/i, taken);
	const signed = moneyIn && moneyOut ? null : pick(headers, /amount|value/i, taken);
	const amount: BankCsvMapping["amount"] =
		moneyIn && moneyOut
			? { kind: "split", moneyIn, moneyOut }
			: { kind: "signed", column: signed ?? headers[2] ?? headers[0], positiveMeans: "in" };
	const at = headers.indexOf(date);
	return {
		ok: true,
		value: {
			headers,
			sample: rows.slice(0, 5),
			rowCount: rows.length,
			guess: {
				date,
				dateFormat: guessDateFormat(rows.slice(0, 50).map((r) => r[at] ?? "")),
				description,
				amount,
				bankId: pick(headers, /transaction id|reference|fitid|^id$|ref\b/i, taken),
				currency: pick(headers, /currency|ccy/i, taken),
			},
		},
	};
}
