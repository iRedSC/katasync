import { describe, expect, it } from "vitest";
import {
	lastMonth,
	parsePeriod,
	periodDays,
	periodText,
	shiftPeriod,
	taxedElsewhere,
} from "./sales-report";

describe("months", () => {
	it("reads a month and nothing else", () => {
		expect(parsePeriod("2026-09")).toEqual({ year: 2026, month: 9 });
		expect(parsePeriod("2026-13")).toBeNull();
		expect(parsePeriod("2026-Q3")).toBeNull();
		expect(parsePeriod("2026")).toBeNull();
	});

	it("steps across year ends", () => {
		expect(periodText(shiftPeriod({ year: 2026, month: 1 }, -1))).toBe(
			"2025-12",
		);
		expect(periodText(shiftPeriod({ year: 2026, month: 12 }, 1))).toBe(
			"2027-01",
		);
	});

	it("knows each month's last day", () => {
		expect(periodDays({ year: 2028, month: 2 })).toBe(
			"February 1 to February 29, 2028",
		);
	});

	it("takes last month in shop time", () => {
		// 2am UTC on Nov 1 is still October 31 in New York.
		expect(periodText(lastMonth(new Date("2026-11-01T02:00:00Z")))).toBe(
			"2026-09",
		);
		expect(periodText(lastMonth(new Date("2026-01-15T12:00:00Z")))).toBe(
			"2025-12",
		);
	});
});

describe("taxedElsewhere", () => {
	const row = {
		country: "US",
		state: "PA",
		how: "shipped" as const,
		tax: 5,
	};

	it("leaves our own state alone", () => {
		expect(taxedElsewhere(row, "PA")).toBe(false);
	});

	it("flags tax on orders shipped to another state", () => {
		expect(taxedElsewhere({ ...row, state: "OH" }, "PA")).toBe(true);
	});

	it("leaves in-person sales at an out-of-state show alone", () => {
		expect(taxedElsewhere({ ...row, state: "OH", how: "in_store" }, "PA")).toBe(
			false,
		);
	});

	it("flags tax on orders shipped abroad, whatever their region code", () => {
		// County Cork is "CO", like Colorado.
		expect(taxedElsewhere({ ...row, country: "IE", state: null }, "PA")).toBe(
			true,
		);
	});

	it("leaves untaxed orders alone", () => {
		expect(taxedElsewhere({ ...row, state: "OH", tax: 0 }, "PA")).toBe(false);
	});
});
