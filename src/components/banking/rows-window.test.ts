import { describe, expect, it } from "vitest";
import { grow, PAGE, windowRows } from "./rows-window";

const rows = Array.from({ length: PAGE * 2 + 5 }, (_, i) => i);

describe("windowRows", () => {
	it("shows the first page and counts the rest", () => {
		const w = windowRows(rows, PAGE);
		expect(w.shown).toHaveLength(PAGE);
		expect(w.hidden).toBe(PAGE + 5);
	});

	it("reaches every row by growing a page at a time", () => {
		let limit = PAGE;
		while (windowRows(rows, limit).hidden > 0)
			limit = grow(limit, rows.length, false);
		expect(windowRows(rows, limit).shown).toEqual(rows);
	});

	it("shows everything at once on request", () => {
		const w = windowRows(rows, grow(PAGE, rows.length, true));
		expect(w.hidden).toBe(0);
		expect(w.shown).toHaveLength(rows.length);
	});

	it("hides nothing in a short list", () => {
		expect(windowRows([1, 2], PAGE)).toEqual({ shown: [1, 2], hidden: 0 });
	});
});
