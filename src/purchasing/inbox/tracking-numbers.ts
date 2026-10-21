// Finds tracking numbers in a supplier's email, by the shapes carriers give
// them. UPS and USPS numbers can't be mistaken for much else. A FedEx number
// is just 12 or 15 digits, as an invoice or order number can be, so those
// only count when the email says FedEx. Freight (PRO numbers) isn't followed.

export type Carrier = "ups" | "usps" | "fedex";
export type FoundTracking = { carrier: Carrier; number: string };

const MAX_PER_EMAIL = 10;

// Uppercase, spaces and dashes out: "1Z 999 AA1 01 2345 6784" reads as one.
export const normalTracking = (n: string) =>
	n.toUpperCase().replace(/[\s-]/g, "");

export function guessCarrier(number: string): Carrier | null {
	const n = normalTracking(number);
	if (/^1Z[0-9A-Z]{16}$/.test(n)) return "ups";
	if (/^9[2-5]\d{18,20}$/.test(n) || /^[A-Z]{2}\d{9}US$/.test(n)) return "usps";
	if (/^(\d{12}|\d{15}|96\d{20})$/.test(n)) return "fedex";
	return null;
}

export function findTracking(text: string): FoundTracking[] {
	const found = new Map<string, Carrier>();
	const add = (number: string, carrier: Carrier) => {
		if (found.size < MAX_PER_EMAIL && !found.has(number))
			found.set(number, carrier);
	};
	for (const m of text.matchAll(/\b1Z(?:[ -]?[0-9A-Z]){16}\b/gi))
		add(normalTracking(m[0]), "ups");
	// Digit runs, allowing the spaces carriers print in groups.
	const saysFedex = /fed\s?ex/i.test(text);
	for (const m of text.matchAll(/(?<![\d#])\d(?:[ -]?\d){11,21}(?!\d)/g)) {
		const n = normalTracking(m[0]);
		if (/^9[2-5]\d{18,20}$/.test(n)) add(n, "usps");
		else if (saysFedex && /^(\d{12}|\d{15}|96\d{20})$/.test(n)) add(n, "fedex");
	}
	for (const m of text.matchAll(/\b[A-Z]{2}\d{9}US\b/g)) add(m[0], "usps");
	return [...found].map(([number, carrier]) => ({ carrier, number }));
}
