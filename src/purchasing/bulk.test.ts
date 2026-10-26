import { describe, expect, test } from "vitest";
import { breaksProblem, convertBreaks, nextBreak, priceAt } from "./bulk";

const list = {
	cost: 10,
	breaks: [
		{ minQuantity: 10, cost: 8 },
		{ minQuantity: 25, cost: 7 },
	],
};

describe("priceAt", () => {
	test("takes the lowest price the quantity reaches", () => {
		expect(priceAt(list, 9)).toBe(10);
		expect(priceAt(list, 10)).toBe(8);
		expect(priceAt(list, 40)).toBe(7);
	});

	test("never charges a stale bulk price above the price", () => {
		expect(priceAt({ cost: 6, breaks: list.breaks }, 30)).toBe(6);
	});

	test("a bulk price applies even with no price", () => {
		expect(priceAt({ cost: null, breaks: list.breaks }, 5)).toBe(null);
		expect(priceAt({ cost: null, breaks: list.breaks }, 12)).toBe(8);
	});
});

describe("nextBreak", () => {
	test("is close most of the way there", () => {
		expect(nextBreak(list, 8, 10)).toMatchObject({
			minQuantity: 10,
			more: 2,
			extra: 0,
			close: true,
		});
		expect(nextBreak(list, 5, 10)).toMatchObject({ more: 5, close: false });
	});

	test("is close when the bigger order costs no more", () => {
		// 20 at $10 is $200; 30 at $6 would be $180.
		expect(
			nextBreak({ cost: 10, breaks: [{ minQuantity: 30, cost: 6 }] }, 20, 10),
		).toMatchObject({ extra: -20, close: true });
	});

	test("skips bulk prices the line already beats", () => {
		expect(nextBreak(list, 12, 6.5)).toBe(null);
		expect(nextBreak(list, 12, 8)).toMatchObject({ minQuantity: 25 });
	});
});

describe("breaksProblem", () => {
	test("wants each under the price and the ones before it", () => {
		expect(breaksProblem(10, 1, list.breaks)).toBe(null);
		expect(
			breaksProblem(10, 1, [
				{ minQuantity: 10, cost: 8 },
				{ minQuantity: 25, cost: 9 },
			]),
		).toMatch("under 8");
	});

	test("wants more than the minimum order", () => {
		expect(breaksProblem(10, 10, list.breaks)).toMatch("at least 10");
	});
});

describe("convertBreaks", () => {
	test("keeps the same number of the product at the same price each", () => {
		expect(convertBreaks(list.breaks, 1, 6, 1)).toEqual({
			breaks: [
				{ minQuantity: 2, cost: 48 },
				{ minQuantity: 5, cost: 42 },
			],
			floor: null,
		});
	});

	test("one every order reaches becomes the price", () => {
		expect(convertBreaks(list.breaks, 1, 12, 1)).toEqual({
			breaks: [{ minQuantity: 3, cost: 84 }],
			floor: 96,
		});
		expect(convertBreaks(list.breaks, 1, 1, 10)).toEqual({
			breaks: [{ minQuantity: 25, cost: 7 }],
			floor: 8,
		});
	});
});
