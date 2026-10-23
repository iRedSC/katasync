import { type } from "arktype";
import type { BankCsvMapping } from "#/db/banking-schema";
import { clip, type Parsed } from "./money";

const header = "0 < string <= 100";

export const mappingInput = type({
	date: header,
	dateFormat: "'ymd' | 'mdy' | 'dmy'",
	description: header,
	amount: type({
		kind: "'signed'",
		column: header,
		positiveMeans: "'in' | 'out'",
	}).or({ kind: "'split'", moneyIn: header, moneyOut: header }),
	bankId: type(header).or("null"),
	currency: type(header).or("null"),
});

type Satisfies<T extends BankCsvMapping> = T;
export type MappingInput = Satisfies<typeof mappingInput.infer>;

export type Columns = {
	date: number;
	description: number;
	amount:
		| { kind: "signed"; column: number; positiveMeans: "in" | "out" }
		| { kind: "split"; moneyIn: number; moneyOut: number };
	bankId: number | null;
	currency: number | null;
};

export function resolveMapping(
	headers: readonly string[],
	mapping: BankCsvMapping,
): Parsed<Columns> {
	const used = new Map<number, string>();
	const problems: string[] = [];
	const find = (role: string, name: string): number => {
		const at = headers.indexOf(name.trim());
		if (at === -1) {
			problems.push(`${role}: no column "${clip(name)}"`);
			return -1;
		}
		const other = used.get(at);
		if (other) problems.push(`${role} and ${other} both use "${clip(name)}"`);
		used.set(at, role);
		return at;
	};
	const date = find("Date", mapping.date);
	const description = find("Description", mapping.description);
	const amount: Columns["amount"] =
		mapping.amount.kind === "signed"
			? {
					kind: "signed",
					column: find("Amount", mapping.amount.column),
					positiveMeans: mapping.amount.positiveMeans,
				}
			: {
					kind: "split",
					moneyIn: find("Money in", mapping.amount.moneyIn),
					moneyOut: find("Money out", mapping.amount.moneyOut),
				};
	const bankId =
		mapping.bankId === null ? null : find("Bank ID", mapping.bankId);
	const currency =
		mapping.currency === null ? null : find("Currency", mapping.currency);
	if (problems.length > 0) return { ok: false, problem: problems.join("; ") };
	return { ok: true, value: { date, description, amount, bankId, currency } };
}
