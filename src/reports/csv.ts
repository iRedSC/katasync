export class Decimal {
	readonly #text: string;

	private constructor(text: string) {
		this.#text = text;
	}

	static of(value: number, places = 2) {
		return new Decimal(Number.isFinite(value) ? value.toFixed(places) : "");
	}

	toString() {
		return this.#text;
	}
}

export const decimal = (value: number, places = 2) => Decimal.of(value, places);

export type Cell = string | number | null | Decimal;

const FORMULA = /^[=+\-@\t\r]|^\s+[=+\-@]/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

export function csvCell(value: Cell): string {
	if (value === null) return "";
	if (value instanceof Decimal) return value.toString();
	if (typeof value === "number")
		return Number.isFinite(value) ? String(value) : "";
	const safe = FORMULA.test(value) ? `'${value}` : value;
	return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvText(rows: Cell[][]): string {
	return rows.map((r) => `${r.map(csvCell).join(",")}\r\n`).join("");
}
