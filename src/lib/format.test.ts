import { describe, expect, test } from "vitest";
import { formatDay, formatOrderDate, formatTime } from "./format";

// The shop's day is America/New_York, so these instants fall on the 21st and
// 22nd there even where the runtime's clock says otherwise.
describe("order dates", () => {
	// 2:08 PM EDT on Oct 21.
	const placed = new Date("2026-10-21T18:08:00Z");

	test("says Today from the shop's day, whatever the runtime's zone", () => {
		// 10:00 PM EDT on Oct 21: still the same shop day, though UTC says the 22nd.
		const today = new Date("2026-10-22T02:00:00Z");
		expect(formatOrderDate(placed, today)).toBe(
			`Today at ${formatTime(placed)}`,
		);
	});

	test("says Yesterday across midnight in the shop's zone", () => {
		// 12:01 AM EDT on Oct 22.
		const today = new Date("2026-10-22T04:01:00Z");
		const justBefore = new Date("2026-10-22T03:59:00Z");
		expect(formatOrderDate(justBefore, today)).toBe(
			`Yesterday at ${formatTime(justBefore)}`,
		);
	});

	test("names an older day by its date", () => {
		const today = new Date("2026-10-23T12:00:00Z");
		expect(formatOrderDate(placed, today)).toBe(
			`Oct 21 at ${formatTime(placed)}`,
		);
	});

	test("with no clock, names the date alone", () => {
		expect(formatOrderDate(placed, null)).toBe(
			`Oct 21 at ${formatTime(placed)}`,
		);
	});

	test("a date-only label is the same in any runtime zone", () => {
		// 10:00 PM EDT on Oct 21 is 2:00 AM UTC on Oct 22.
		expect(formatDay("2026-10-22T02:00:00Z")).toBe("Oct 21");
	});
});
