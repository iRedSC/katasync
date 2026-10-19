// Splits the insured amount across boxes by cents, the last box taking any
// leftover cent, so the parts add up to what was chosen.
export function splitInsurance(total: number | null, boxes: number) {
	if (total === null) return Array<null>(boxes).fill(null);
	const cents = Math.round(total * 100);
	const each = Math.floor(cents / boxes);
	return Array.from(
		{ length: boxes },
		(_, i) => (i === boxes - 1 ? cents - each * (boxes - 1) : each) / 100,
	);
}

// The insurance field's text as an amount; nothing typed (or 0) is none.
export function parseInsurance(text: string): number | null {
	const amount = Math.round(Number(text) * 100) / 100;
	return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// What's typed into the insurance field: digits and one decimal point, at
// most cents.
export function typeInsurance(raw: string): string {
	const [whole, ...rest] = raw.replace(/[^\d.]/g, "").split(".");
	return rest.length === 0 ? whole : `${whole}.${rest.join("").slice(0, 2)}`;
}

// Tab on the insurance field: full coverage, or back to none if it's
// already full.
export function toggleFullCoverage(text: string, total: number): string {
	return parseInsurance(text) === parseInsurance(String(total))
		? ""
		: insuranceText(total);
}

// An amount as the field shows it: whole dollars bare, else with cents.
export function insuranceText(amount: number | null): string {
	if (amount === null) return "";
	const cents = Math.round(amount * 100);
	return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}
