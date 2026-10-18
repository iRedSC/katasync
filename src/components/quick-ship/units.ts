import type { Dims } from "./types";

export const MM_PER_INCH = 25.4;
export const GRAMS_PER_OUNCE = 28.349523125;

export const inches = (mm: number) => Math.round((mm / MM_PER_INCH) * 10) / 10;
export const ounces = (grams: number) => (grams / GRAMS_PER_OUNCE).toFixed(1);
export const size = (d: Dims) =>
	`${inches(d.lengthMm)} × ${inches(d.widthMm)} × ${inches(d.heightMm)}`;
