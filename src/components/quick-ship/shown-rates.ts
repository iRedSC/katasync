import { sameExtras } from "./starting-extras";
import type { Extras, Rates } from "./types";

// The prices on screen: the extras they were quoted with, and whether
// buying at them was refused because a price rose. Refused prices stay up,
// dimmed, but nothing buys at them until fresh ones arrive.
export type ShownRates = Rates & { for: Extras; refused: boolean };

export const quoted = (rates: Rates, extras: Extras): ShownRates => ({
	...rates,
	for: extras,
	refused: false,
});

export const refuse = (rates: ShownRates | null) =>
	rates && { ...rates, refused: true };

// Whether a label may be bought at these prices with these extras.
export const buyable = (
	rates: ShownRates | null,
	extras: Extras,
): rates is ShownRates =>
	rates !== null && !rates.refused && sameExtras(rates.for, extras);
