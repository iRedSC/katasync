import type { BankDateFormat } from "#/db/banking-schema";
import { SHOP_TIME_ZONE } from "#/lib/format";
import { clip, type Parsed } from "./money";

const PARTS = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/;

export const DATE_FORMATS: Record<BankDateFormat, string> = {
	ymd: "2026-10-23",
	mdy: "10/23/2026",
	dmy: "23/10/2026",
};

export function parseBankDate(
	input: string,
	format: BankDateFormat,
): Parsed<string> {
	const text = input.trim();
	const m = PARTS.exec(text);
	const bad = { ok: false as const, problem: `"${clip(input)}" isn't a date` };
	if (!m) return bad;
	const [a, b, c] = [m[1], m[2], m[3]];
	const [y, mo, d] =
		format === "ymd" ? [a, b, c] : format === "mdy" ? [c, a, b] : [c, b, a];
	if (y.length !== 4 || mo.length > 2 || d.length > 2) return bad;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	if (year < 1990 || year > 2100)
		return { ok: false, problem: `"${clip(input)}" is out of range` };
	const at = new Date(Date.UTC(year, month - 1, day));
	if (
		at.getUTCFullYear() !== year ||
		at.getUTCMonth() !== month - 1 ||
		at.getUTCDate() !== day
	)
		return bad;
	return { ok: true, value: at.toISOString().slice(0, 10) };
}

const shopDate = new Intl.DateTimeFormat("en-CA", {
	timeZone: SHOP_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

export function shopDay(at: Date | string): string {
	return shopDate.format(new Date(at));
}

export function daysBetween(a: string, b: string): number {
	return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
