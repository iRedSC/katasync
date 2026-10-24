import { parse } from "csv-parse/sync";
import { clip, type Parsed } from "./money";

export const LIMITS = {
	fileBytes: 2_000_000,
	rows: 10_000,
	columns: 50,
	headerLength: 100,
	cellLength: 1_000,
} as const;

export type CsvTable = { headers: string[]; rows: string[][] };

export function readCsv(text: string): Parsed<CsvTable> {
	if (new TextEncoder().encode(text).length > LIMITS.fileBytes)
		return {
			ok: false,
			problem: `The file is over ${LIMITS.fileBytes / 1_000_000} MB`,
		};
	let records: string[][];
	try {
		records = parse(text, {
			bom: true,
			relax_column_count: true,
			skip_empty_lines: true,
			max_record_size: LIMITS.cellLength * LIMITS.columns,
		}) as string[][];
	} catch (e) {
		return {
			ok: false,
			problem: `The file isn't readable CSV: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	const [head, ...rows] = records;
	if (!head) return { ok: false, problem: "The file is empty" };
	const headers = head.map((h) => h.trim());
	if (headers.length > LIMITS.columns)
		return {
			ok: false,
			problem: `The file has ${headers.length} columns; at most ${LIMITS.columns}`,
		};
	const seen = new Set<string>();
	for (const h of headers) {
		if (h === "") return { ok: false, problem: "A column has no header" };
		if (h.length > LIMITS.headerLength)
			return { ok: false, problem: `Header "${clip(h)}" is too long` };
		const key = h.toLowerCase();
		if (seen.has(key))
			return { ok: false, problem: `Two columns are named "${clip(h)}"` };
		seen.add(key);
	}
	if (rows.length === 0) return { ok: false, problem: "The file has no rows" };
	if (rows.length > LIMITS.rows)
		return {
			ok: false,
			problem: `The file has ${rows.length} rows; at most ${LIMITS.rows}`,
		};
	return { ok: true, value: { headers, rows } };
}
