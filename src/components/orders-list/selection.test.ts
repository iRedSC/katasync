import { describe, expect, test } from "vitest";
import { headerState, printPlan, toggle, toggleAll } from "./selection";

const rows = [1, 2, 3, 4, 5].map((id) => ({ id, labelToVoid: id === 5 }));
const ids = (ticks: ReadonlySet<number>) => [...ticks].sort();

describe("ticking", () => {
	test("a shift-click ticks the range from the last click", () => {
		const one = toggle(new Set(), rows, 0, null, false);
		expect(ids(toggle(one, rows, 3, 0, true))).toEqual([1, 2, 3, 4]);
	});

	test("the range takes the clicked row's new state", () => {
		const all = new Set([1, 2, 3, 4]);
		expect(ids(toggle(all, rows, 1, 3, true))).toEqual([1]);
	});

	test("ticking all leaves ticks hidden by a filter alone", () => {
		const shown = rows.slice(0, 2);
		const ticks = toggleAll(new Set([4]), shown);
		expect(ids(ticks)).toEqual([1, 2, 4]);
		expect(ids(toggleAll(ticks, shown))).toEqual([4]);
		expect(headerState(new Set([4]), shown)).toBe("none");
	});
});

describe("what Print prints", () => {
	test("ticked orders, but only the ones shown", () => {
		expect(
			printPlan({
				view: "ship",
				ticks: new Set([1, 4]),
				shown: rows.slice(0, 3),
				filtering: true,
			}),
		).toEqual({ kind: "ids", ids: [1], why: "ticked", leftOut: 0 });
	});

	test("everything to ship when nothing is ticked or filtered", () => {
		expect(
			printPlan({
				view: "ship",
				ticks: new Set(),
				shown: rows,
				filtering: false,
			}),
		).toEqual({ kind: "all" });
	});

	test("a filtered list prints what it shows, less labels to void", () => {
		expect(
			printPlan({
				view: "ship",
				ticks: new Set(),
				shown: rows,
				filtering: true,
			}),
		).toEqual({ kind: "ids", ids: [1, 2, 3, 4], why: "shown", leftOut: 1 });
	});

	test("All orders prints only what's ticked", () => {
		expect(
			printPlan({
				view: "all",
				ticks: new Set(),
				shown: rows,
				filtering: false,
			}),
		).toBeNull();
	});
});
