import { describe, expect, test } from "vitest";
import { timelyUnits } from "./reorder";

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 23);
const on = (days: number) => TODAY + days * DAY;

describe("timelyUnits", () => {
	test("a delivery after the shelf runs out isn't in time", () => {
		expect(timelyUnits(TODAY, 5, 1, [{ units: 40, arrivesAt: on(20) }])).toBe(
			0,
		);
	});

	test("a delivery before the shelf runs out is", () => {
		expect(timelyUnits(TODAY, 5, 1, [{ units: 20, arrivesAt: on(3) }])).toBe(
			20,
		);
	});

	test("each delivery in time keeps the shelf going for the next", () => {
		expect(
			timelyUnits(TODAY, 5, 1, [
				{ units: 10, arrivesAt: on(12) },
				{ units: 10, arrivesAt: on(4) },
			]),
		).toBe(20);
	});

	test("back-ordered and overdue units have no date, so they're never in time", () => {
		expect(
			timelyUnits(TODAY, 9, 0, [
				{ units: 40, arrivesAt: null },
				{ units: 10, arrivesAt: on(-3) },
				{ units: 5, arrivesAt: on(300) },
			]),
		).toBe(5);
	});
});
