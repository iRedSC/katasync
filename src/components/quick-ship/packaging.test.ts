import { describe, expect, test } from "vitest";
import { setsDefault } from "./packaging";
import type { Box, Packed } from "./types";

const dims = { lengthMm: 300, widthMm: 200, heightMm: 100 };
const saved = { id: 7, ...dims } as Box;
const packed = (box: Box | null, d = dims): Packed => ({
	box,
	dims: d,
	weightGrams: 500,
	hazmat: false,
});
const last = [
	{ packageId: 7, ...dims, weightGrams: 450, hazmat: false },
] as const;

describe("setsDefault", () => {
	test("the first shipment of these contents is the default", () => {
		expect(setsDefault({ last: null }, [packed(null)], false)).toBe(true);
	});

	test("the default box again keeps it, with the new weight", () => {
		expect(setsDefault({ last: [...last] }, [packed(saved)], false)).toBe(true);
	});

	test("another box is a one-off unless asked", () => {
		const other = packed(null, { ...dims, heightMm: 50 });
		expect(setsDefault({ last: [...last] }, [other], false)).toBe(false);
		expect(setsDefault({ last: [...last] }, [other], true)).toBe(true);
	});

	test("a different number of boxes is another packing", () => {
		const two = [packed(saved), packed(saved)];
		expect(setsDefault({ last: [...last] }, two, false)).toBe(false);
	});
});
