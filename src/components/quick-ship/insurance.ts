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
