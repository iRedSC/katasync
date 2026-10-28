import { describe, expect, it } from "vitest";
import { buyable, quoted, refuse } from "./shown-rates";
import type { Extras, Rates } from "./types";

const none: Extras = { insure: null, signature: false };
const rates: Rates = { list: [], notes: [], test: false };

describe("shown rates", () => {
	it("never buys at prices a price rise refused, even once asking again fails", () => {
		const shown = quoted(rates, none);
		expect(buyable(shown, none)).toBe(true);
		// The buy was refused; asking again failed, so these stay on screen.
		expect(buyable(refuse(shown), none)).toBe(false);
	});

	it("buys again once fresh prices arrive", () => {
		expect(buyable(quoted(rates, none), none)).toBe(true);
	});

	it("never buys at prices quoted for other extras", () => {
		expect(
			buyable(quoted(rates, none), { insure: 100, signature: false }),
		).toBe(false);
		expect(buyable(null, none)).toBe(false);
	});
});
