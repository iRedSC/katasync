const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null): string {
	const text =
		value === null
			? ""
			: typeof value === "number"
				? String(value)
				: FORMULA.test(value)
					? `'${value}`
					: value;
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(lines: (string | number | null)[][]): string {
	return lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
}
