import { describe, expect, test } from "vitest";
import {
	type Day,
	daysOf,
	describePeriod,
	parsePeriod,
	spellPeriod,
} from "./period";

// A Friday.
const on = "2026-10-16" as Day;
const days = (key: Parameters<typeof daysOf>[0]) => daysOf(key, on);
const range = (key: "this_week" | "last_week" | "last_month" | "this_year") =>
	days({ kind: "range", key });

describe("named ranges", () => {
	test("weeks start on Saturday", () => {
		expect(range("this_week")).toEqual({ from: "2026-10-10", to: on });
		expect(range("last_week")).toEqual({
			from: "2026-10-03",
			to: "2026-10-09",
		});
		// Saturday starts its own week.
		expect(
			daysOf({ kind: "range", key: "this_week" }, "2026-10-17" as Day),
		).toEqual({ from: "2026-10-17", to: "2026-10-17" });
	});

	test("last month runs to its own last day, across a year", () => {
		expect(range("last_month")).toEqual({
			from: "2026-09-01",
			to: "2026-09-30",
		});
		expect(
			daysOf({ kind: "range", key: "last_month" }, "2026-01-05" as Day),
		).toEqual({ from: "2025-12-01", to: "2025-12-31" });
	});
});

describe("words", () => {
	test("round trip, open ends, and days in either order", () => {
		for (const text of [
			"today",
			"2026-10-01..2026-10-15",
			"2026-10-01..",
			"..2026-10-15",
			"..",
		]) {
			const p = parsePeriod(text);
			expect(p && spellPeriod(p)).toBe(text);
		}
		expect(parsePeriod("2026-10-15..2026-10-01")).toEqual({
			kind: "days",
			from: "2026-10-01",
			to: "2026-10-15",
		});
	});

	test("anything not a real day is refused, not left open", () => {
		expect(parsePeriod("2026-02-30..")).toBeNull();
		expect(parsePeriod("oct..")).toBeNull();
		expect(parsePeriod("someday")).toBeNull();
	});

	test("in words", () => {
		const d = (t: string) => describePeriod(parsePeriod(t) as never, on);
		expect(d("2026-10-01..2026-10-15")).toBe("Oct 1 – 15");
		expect(d("2026-10-01..")).toBe("Since Oct 1");
		expect(d("..2025-12-31")).toBe("Until Dec 31, 2025");
		expect(d("..")).toBe("All time");
		expect(d("last_month")).toBe("Last month");
	});
});
