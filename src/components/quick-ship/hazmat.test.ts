import { describe, expect, test } from "vitest";
import { startsHazmat } from "./hazmat";

const box = (hazmat: boolean) => ({
	packageId: null,
	lengthMm: 1,
	widthMm: 1,
	heightMm: 1,
	weightGrams: 1,
	hazmat,
});
const line = (aerosol: boolean) =>
	({ aerosol }) as Parameters<typeof startsHazmat>[0]["lines"][number];

describe("startsHazmat", () => {
	test("an aerosol product marks every box when last time doesn't say", () => {
		const plan = { lines: [line(false), line(true)], last: null };
		expect(startsHazmat(plan, 0)).toBe(true);
		expect(startsHazmat(plan, 1)).toBe(true);
	});

	test("an aerosol product overrides a last time with no aerosol box", () => {
		// Flagged after these contents last shipped.
		expect(startsHazmat({ lines: [line(true)], last: [box(false)] }, 0)).toBe(
			true,
		);
	});

	test("last time's aerosol boxes say which box holds the can", () => {
		const plan = { lines: [line(true)], last: [box(false), box(true)] };
		expect(startsHazmat(plan, 0)).toBe(false);
		expect(startsHazmat(plan, 1)).toBe(true);
		expect(startsHazmat(plan, 2)).toBe(false);
	});

	test("no aerosols: unmarked", () => {
		expect(startsHazmat({ lines: [line(false)], last: null }, 0)).toBe(false);
	});
});
