import { describe, expect, it } from "vitest";
import { searchView } from "./search-answer";

describe("searchView", () => {
	it("lets the rows for what's typed be picked", () => {
		const v = searchView({ q: "abc", rows: [1, 2] }, "abc", null);
		expect(v).toMatchObject({ rows: [1, 2], stale: false, searching: false });
	});

	it("keeps the last rows up but not pickable while the next search runs", () => {
		const v = searchView({ q: "ab", rows: [1] }, "abc", null);
		expect(v).toMatchObject({ rows: [1], stale: true, searching: true });
	});

	it("shows no rows, and stops waiting, once the search failed", () => {
		const v = searchView({ q: "ab", rows: [1] }, "abc", "abc");
		expect(v).toMatchObject({ rows: [], failed: true, searching: false });
	});

	it("ignores a failure of an older query", () => {
		expect(searchView(null, "abc", "ab")).toMatchObject({
			failed: false,
			searching: true,
		});
	});

	it("is idle with nothing typed", () => {
		expect(searchView(null, "", null).searching).toBe(false);
	});
});
