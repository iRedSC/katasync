import type { Dims } from "./types";

export const MM_PER_INCH = 25.4;
export const GRAMS_PER_OUNCE = 28.349523125;

export const inches = (mm: number) => Math.round((mm / MM_PER_INCH) * 10) / 10;
export const ounces = (grams: number) => (grams / GRAMS_PER_OUNCE).toFixed(1);
export const size = (d: Dims) =>
	`${inches(d.lengthMm)} × ${inches(d.widthMm)} × ${inches(d.heightMm)}`;

// Packed weight as Seller Central takes it, pounds and ounces.
export function poundsOunces(grams: number) {
	const oz = Math.round((grams / GRAMS_PER_OUNCE) * 10) / 10;
	const lb = Math.floor(oz / 16);
	const rest = Math.round((oz - lb * 16) * 10) / 10;
	return lb > 0 ? `${lb} lb${rest > 0 ? ` ${rest} oz` : ""}` : `${rest} oz`;
}

export const formatBox = (box: [number, number, number]) =>
	`${box.map(inches).join(" × ")} in`;
