import { formatMoney } from "#/lib/format";

// Discounts on a PO line: a percent or dollars off some of its units. On its
// own so the browser works out totals exactly as the server saves them.

export type DiscountOff =
	| { kind: "percent"; percent: number }
	| { kind: "amount"; amount: number };

export type Discount = {
	// How many of the line's unit it covers, or "rest": every unit no other
	// discount covers, so it follows the line's quantity.
	units: number | "rest";
	off: DiscountOff;
};

// As stored: exactly one of percent and amount (the table checks it).
export function discountOf<
	R extends {
		units: number | null;
		percent: number | null;
		amount: number | null;
	},
>(row: R): Omit<R, "units" | "percent" | "amount"> & Discount {
	const { units, percent, amount, ...rest } = row;
	return {
		...rest,
		units: units ?? "rest",
		off:
			percent !== null
				? { kind: "percent", percent }
				: { kind: "amount", amount: amount ?? 0 },
	};
}

// As stored, the other way.
export const discountRow = (d: Discount) => ({
	units: d.units === "rest" ? null : d.units,
	percent: d.off.kind === "percent" ? d.off.percent : null,
	amount: d.off.kind === "amount" ? d.off.amount : null,
});

type Line = { quantity: number; unitCost: number | null };

const fixedUnits = (discounts: Discount[]) =>
	discounts.reduce((n, d) => n + (d.units === "rest" ? 0 : d.units), 0);

// The units each discount covers, in order.
export function coveredUnits(quantity: number, discounts: Discount[]) {
	const rest = Math.max(quantity - fixedUnits(discounts), 0);
	return discounts.map((d) => (d.units === "rest" ? rest : d.units));
}

// Units of a delivery that its discounts don't cover yet. Discounts that came
// with the delivery, together, can't cover more than it brought.
export const receiptLeft = (received: number, discounts: Discount[]) =>
	received - fixedUnits(discounts);

// Cents off, or null when it's a percent of a price nobody knows yet.
function centsOff(off: DiscountOff, units: number, unitCost: number | null) {
	if (off.kind === "amount") return Math.round(off.amount * 100);
	return unitCost === null ? null : Math.round(units * unitCost * off.percent);
}

// Cents off each discount takes, in order; null where it can't be known.
// Each rounds to the cent on its own, so together they could pass the line's
// own rounded amount (two 1-unit free discounts at half a cent each): once
// they reach it, the rest take only what's left, and a line never goes below
// $0.
function centsEach(line: Line, discounts: Discount[]) {
	const units = coveredUnits(line.quantity, discounts);
	let left =
		line.unitCost === null
			? Number.POSITIVE_INFINITY
			: Math.round(line.quantity * line.unitCost * 100);
	return discounts.map((d, i) => {
		const c = centsOff(d.off, units[i], line.unitCost);
		if (c === null) return null;
		const taken = Math.min(c, left);
		left -= taken;
		return taken;
	});
}

// Dollars off each discount takes, in order; null where it can't be known.
export function discountValues(line: Line, discounts: Discount[]) {
	return centsEach(line, discounts).map((c) => (c === null ? null : c / 100));
}

// Quantity × price less every discount, in cents; null with no price.
export function lineCents(line: Line, discounts: Discount[]) {
	if (line.unitCost === null) return null;
	const before = Math.round(line.quantity * line.unitCost * 100);
	return centsEach(line, discounts).reduce<number>(
		(n, c) => n - (c ?? 0),
		before,
	);
}

export function lineTotal(line: Line, discounts: Discount[]) {
	const c = lineCents(line, discounts);
	return c === null ? null : c / 100;
}

// Why these discounts can't be on this line as it is, or null when they can.
// Every change to a line, its price, or its discounts is checked with this.
export function discountProblem(
	line: Line,
	discounts: Discount[],
): string | null {
	if (discounts.filter((d) => d.units === "rest").length > 1)
		return "Only one discount can cover all the rest";
	const fixed = fixedUnits(discounts);
	if (fixed > line.quantity)
		return `Discounts cover ${fixed}, but the line has ${line.quantity}. Change or take off a discount first.`;
	if (line.unitCost === null) return null;
	const units = coveredUnits(line.quantity, discounts);
	for (const [i, d] of discounts.entries()) {
		if (d.off.kind !== "amount") continue;
		const worth = Math.round(units[i] * line.unitCost * 100);
		if (Math.round(d.off.amount * 100) > worth)
			return `${formatMoney(d.off.amount)} off ${units[i]} is more than they cost (${formatMoney(worth / 100)}). Change or take off that discount first.`;
	}
	return null;
}

// What each of a receipt's units cost after discounts, per the line's unit:
// the receipt's own discounts on the units they cover, and the line's other
// discounts spread over every unit not taken by some receipt's discount.
// Never below 0.
export function receiptUnitCost(input: {
	line: { quantity: number; unitCost: number };
	discounts: (Discount & { receiptId: number | null })[];
	receipt: { id: number; quantity: number };
}) {
	const { line, discounts, receipt } = input;
	const units = coveredUnits(line.quantity, discounts);
	const values = discountValues(line, discounts);
	let lineOff = 0;
	let takenByReceipts = 0;
	let ownUnits = 0;
	let ownOff = 0;
	discounts.forEach((d, i) => {
		const value = values[i] ?? 0;
		if (d.receiptId === null) lineOff += value;
		else takenByReceipts += units[i];
		if (d.receiptId === receipt.id) {
			ownUnits += units[i];
			ownOff += value;
		}
	});
	const shared = line.quantity - takenByReceipts;
	const spread = shared > 0 ? lineOff / shared : 0;
	const total =
		(receipt.quantity - ownUnits) * (line.unitCost - spread) +
		ownUnits * line.unitCost -
		ownOff;
	return Math.max(total, 0) / receipt.quantity;
}

// For people: "10% off all 12", "$12.00 off 4", "the other 8", "1 free".
export function describeDiscount(
	d: Discount,
	units: number,
	others: boolean,
): string {
	const which =
		d.units === "rest"
			? `${others ? "the other" : "all"} ${units}`
			: `${units}`;
	if (d.off.kind === "percent" && d.off.percent === 100)
		return d.units === "rest" ? `${which} free` : `${units} free`;
	const off =
		d.off.kind === "percent" ? `${d.off.percent}%` : formatMoney(d.off.amount);
	return `${off} off ${which}`;
}

// The same, without counting what "rest" covers now, for history: "10% off
// all", "$12.00 off 4", "4 free".
export function describeTerms(d: Discount): string {
	const which = d.units === "rest" ? "all" : `${d.units}`;
	if (d.off.kind === "percent" && d.off.percent === 100)
		return d.units === "rest" ? "all free" : `${d.units} free`;
	const off =
		d.off.kind === "percent" ? `${d.off.percent}%` : formatMoney(d.off.amount);
	return `${off} off ${which}`;
}

// Whether two lists of discounts are the same terms in the same order, e.g.
// a line's now and as sent.
export const sameDiscounts = (a: Discount[], b: Discount[]) =>
	a.length === b.length &&
	a.every((d, i) => {
		const e = b[i];
		return (
			d.units === e.units &&
			d.off.kind === e.off.kind &&
			(d.off.kind === "percent"
				? e.off.kind === "percent" && d.off.percent === e.off.percent
				: e.off.kind === "amount" && d.off.amount === e.off.amount)
		);
	});
