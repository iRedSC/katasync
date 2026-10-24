declare const currencyBrand: unique symbol;
export type Currency = string & { readonly [currencyBrand]: true };

export const MAX_ABS_CENTS = 999_999_999_999;

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

const known = new Set(
	typeof Intl.supportedValuesOf === "function"
		? Intl.supportedValuesOf("currency")
		: ["USD", "CAD", "EUR", "GBP", "AUD"],
);

export function parseCurrency(input: string): Parsed<Currency> {
	const code = input.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(code))
		return { ok: false, problem: `"${clip(input)}" isn't a currency code` };
	if (!known.has(code))
		return { ok: false, problem: `${code} isn't a known currency` };
	const digits = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: code,
	}).resolvedOptions().maximumFractionDigits;
	if (digits !== 2)
		return {
			ok: false,
			problem: `${code} doesn't use cents, which isn't supported`,
		};
	return { ok: true, value: code as Currency };
}

const AMOUNT =
	/^(?<neg>-)?(?<open>\()?(?<sym>[$€£])?(?<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<frac>\d{1,2}))?(?<close>\))?$/;

export function parseCents(input: string, currency: string): Parsed<number> {
	const raw = input.trim().replaceAll(" ", "");
	if (raw === "") return { ok: false, problem: "Amount is empty" };
	const unsigned = raw.startsWith("+") ? raw.slice(1) : raw;
	const m = AMOUNT.exec(unsigned)?.groups;
	if (!m) return { ok: false, problem: `"${clip(input)}" isn't an amount` };
	const symbol = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency,
		currencyDisplay: "narrowSymbol",
	})
		.formatToParts(0)
		.find((part) => part.type === "currency")?.value;
	if (m.sym && m.sym !== symbol)
		return {
			ok: false,
			problem: `Amount uses ${m.sym}; the account is ${currency}, and conversion isn't supported`,
		};
	const mixed = raw !== unsigned && unsigned.startsWith("-");
	if (mixed || Boolean(m.open) !== Boolean(m.close) || (m.neg && m.open))
		return { ok: false, problem: `"${clip(input)}" isn't an amount` };
	const whole = m.int.replaceAll(",", "");
	if (whole.length > 10)
		return { ok: false, problem: `"${clip(input)}" is too large` };
	const value = Number(whole) * 100 + Number((m.frac ?? "").padEnd(2, "0"));
	if (value > MAX_ABS_CENTS)
		return { ok: false, problem: `"${clip(input)}" is too large` };
	const negative = Boolean(m.neg) || Boolean(m.open);
	return { ok: true, value: negative && value !== 0 ? -value : value };
}

export function toCents(amount: number): number {
	return Math.round(amount * 100);
}

export function formatCents(cents: number, currency: string) {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency,
	}).format(cents / 100);
}

export function clip(text: string, max = 40) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
