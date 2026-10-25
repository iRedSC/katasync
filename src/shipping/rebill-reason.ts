import { formatBox, poundsOunces } from "#/components/quick-ship/units";

// Why Shippo re-billed a label, read from its invoice item's description.
// A carrier's charge correction names the package as billed and as declared,
// in text like "Shipping Charge Correction Ground: Billed Weight (lb): 40.0
// Declared Weight (oz): 74.0 Billed Dimensions (in): 49.0 x 5.0 x 5.0
// Declared Dimensions (in): 47.99 x 4.02 x 4.02". Surcharges only name
// themselves ("Addl. Handling longest side"), so they stay as Shippo wrote
// them, as does any correction in a shape not seen yet.
//
// Billed weight is what the carrier charged for: the scale's, the box's
// dimensional weight, or a surcharge's minimum, whichever is most. It isn't
// necessarily what the box weighed.

export type Box = [number, number, number];
export type Parcel = { weightGrams: number; box: Box };

export type RebillReason =
	| { kind: "correction"; billed: Parcel; declared: Parcel }
	| { kind: "charge"; text: string };

const GRAMS: Record<string, number> = {
	lb: 453.59237,
	lbs: 453.59237,
	oz: 28.349523125,
	kg: 1000,
	g: 1,
};
const MM: Record<string, number> = { in: 25.4, cm: 10, mm: 1 };

const n = String.raw`(\d+(?:\.\d+)?)`;
const weight = (who: string) => String.raw`${who} Weight \((\w+)\):\s*${n}`;
const dims = (who: string) =>
	String.raw`${who} Dimensions \((\w+)\):\s*${n}\s*x\s*${n}\s*x\s*${n}`;
const CORRECTION = new RegExp(
	[weight("Billed"), weight("Declared"), dims("Billed"), dims("Declared")].join(
		String.raw`\s+`,
	),
	"i",
);

function parcel(
	weightUnit: string,
	weightValue: string,
	dimsUnit: string,
	sides: string[],
): Parcel | null {
	const g = GRAMS[weightUnit.toLowerCase()];
	const mm = MM[dimsUnit.toLowerCase()];
	if (g === undefined || mm === undefined) return null;
	return {
		weightGrams: Number(weightValue) * g,
		box: sides.map((s) => Number(s) * mm) as Box,
	};
}

export function rebillReason(description: string): RebillReason {
	const m = CORRECTION.exec(description);
	if (m) {
		const [, bwu, bw, dwu, dw, bdu, b1, b2, b3, ddu, d1, d2, d3] = m;
		const billed = parcel(bwu, bw, bdu, [b1, b2, b3]);
		const declared = parcel(dwu, dw, ddu, [d1, d2, d3]);
		if (billed && declared) return { kind: "correction", billed, declared };
	}
	return { kind: "charge", text: description.trim() };
}

// One line, for plain text such as the inbox alert's.
export function describeRebill(reason: RebillReason) {
	if (reason.kind === "charge") return reason.text;
	const { billed, declared } = reason;
	return `Billed as ${poundsOunces(billed.weightGrams)}, ${formatBox(billed.box)}; declared ${poundsOunces(declared.weightGrams)}, ${formatBox(declared.box)}`;
}
