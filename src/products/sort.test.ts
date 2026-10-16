import { describe, expect, test } from "vitest";
import {
	NUMBER,
	parseSort,
	parseSortWord,
	type SortColumns,
	sortRows,
	spellSort,
	suggestSorts,
	TEXT,
	withTerm,
} from "./sort";

const columns = {
	name: { label: "Name", ...TEXT },
	cost: { label: "Cost", ...NUMBER },
	class: { label: "Class", asc: "A first", desc: "C first" },
} satisfies SortColumns<string>;

type Row = { name: string; cost: number | null; class: string };
const rows: Row[] = [
	{ name: "Box 10", cost: 2, class: "B" },
	{ name: "box 9", cost: null, class: "A" },
	{ name: "Tape", cost: 5, class: "A" },
	{ name: "Wrap", cost: 2, class: "A" },
];
const by = (sort: string) =>
	sortRows(rows, parseSort(sort, columns), (r) => r).map((r) => r.name);

describe("sortRows", () => {
	test("^cost is lowest first, ^!cost highest first, blanks last both ways", () => {
		expect(by("cost")).toEqual(["Box 10", "Wrap", "Tape", "box 9"]);
		expect(by("-cost")).toEqual(["Tape", "Box 10", "Wrap", "box 9"]);
	});

	test("later terms break ties; full ties keep their order", () => {
		expect(by("cost,-name")).toEqual(["Wrap", "Box 10", "Tape", "box 9"]);
		expect(by("class")).toEqual(["box 9", "Tape", "Wrap", "Box 10"]);
	});

	test("text ignores case and reads numbers as numbers", () => {
		expect(by("name")).toEqual(["box 9", "Box 10", "Tape", "Wrap"]);
	});

	test("no sort keeps the order given", () => {
		expect(by("")).toEqual(rows.map((r) => r.name));
	});
});

describe("spelling", () => {
	test("round-trips, dropping unknown columns and repeats", () => {
		const sort = parseSort("-cost,nope,name,cost", columns);
		expect(sort).toEqual([
			{ key: "cost", desc: true },
			{ key: "name", desc: false },
		]);
		expect(spellSort(sort)).toBe("-cost,name");
	});

	test("a key already sorted on changes direction in place", () => {
		const sort = parseSort("cost,name", columns);
		expect(spellSort(withTerm(sort, { key: "cost", desc: true }))).toBe(
			"-cost,name",
		);
		expect(spellSort(withTerm(sort, { key: "class", desc: false }))).toBe(
			"cost,name,class",
		);
	});

	test("reads typed words", () => {
		expect(parseSortWord("^Cost")).toEqual({ value: "cost", desc: false });
		expect(parseSortWord("^!")).toEqual({ value: "", desc: true });
		expect(parseSortWord("cost")).toBeNull();
	});
});

describe("suggestSorts", () => {
	test("prefix matches lead, picked columns are left out", () => {
		expect(suggestSorts(columns, "c", [])).toEqual(["cost", "class"]);
		expect(suggestSorts(columns, "", [{ key: "name", desc: false }])).toEqual([
			"cost",
			"class",
		]);
	});
});
