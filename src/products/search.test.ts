import { describe, expect, test } from "vitest";
import {
	type Facets,
	type Filter,
	facetCounts,
	matches,
	parseQuery,
	parseWord,
	spell,
	suggest,
} from "./search";

function facets(extra: Partial<Facets> = {}): Facets {
	return {
		text: ["Flat Box 12x9", "FB-129"],
		tag: ["Clearance", "Boxes"],
		type: ["Flat Box"],
		vendor: ["Uline"],
		status: ["active"],
		title: ["Flat Box 12x9"],
		...extra,
	};
}

const chip = (f: Omit<Filter, "exact">): Filter => ({ ...f, exact: true });

describe("parseWord", () => {
	test("reads each sigil, with and without !", () => {
		expect(parseWord("#sale")).toMatchObject({
			field: "tag",
			value: "sale",
			exclude: false,
		});
		expect(parseWord("!#sale")).toMatchObject({ field: "tag", exclude: true });
		expect(parseWord("@box")).toMatchObject({ field: "type" });
		expect(parseWord("$uline")).toMatchObject({ field: "vendor" });
		expect(parseWord("%draft")).toMatchObject({ field: "status" });
		expect(parseWord("!!refurb")).toMatchObject({
			field: "title",
			value: "refurb",
			exclude: true,
		});
	});

	test("plain words and a lone ! are search text", () => {
		expect(parseWord("box")).toBeNull();
		expect(parseWord("!box")).toBeNull();
	});

	test("spell writes back what parseWord reads", () => {
		for (const word of ["#a", "!#a", "@b", "!$c", "%d", "!!e"]) {
			const f = parseWord(word);
			expect(f && spell(f)).toBe(word);
		}
	});
});

describe("matches", () => {
	const run = (text: string, extra: Filter[] = [], f = facets()) => {
		const q = parseQuery(text);
		return matches(f, [...extra, ...q.filters], q.words);
	};

	test("every plain word must appear somewhere", () => {
		expect(run("flat 129")).toBe(true);
		expect(run("flat round")).toBe(false);
	});

	test("typed filters match part of a value; chips match all of it", () => {
		expect(run("#clear")).toBe(true);
		expect(
			run("", [chip({ field: "tag", value: "clear", exclude: false })]),
		).toBe(false);
		expect(
			run("", [chip({ field: "tag", value: "clearance", exclude: false })]),
		).toBe(true);
	});

	test("same field is any-of, different fields are all-of", () => {
		expect(run("#nope #boxes")).toBe(true);
		expect(run("#boxes $nope")).toBe(false);
	});

	test("exclusions", () => {
		expect(run("!#clearance")).toBe(false);
		expect(run("!$acme")).toBe(true);
		expect(run("!!12x9")).toBe(false);
		expect(run("!!round")).toBe(true);
	});

	test("a bare sigil filters nothing", () => {
		expect(run("# !!")).toBe(true);
	});
});

describe("suggest", () => {
	const counts = facetCounts([
		facets({ tag: ["Sale", "Boxes"] }),
		facets({ tag: ["Boxes", "Wholesale"] }),
		facets({ tag: ["Boxes"] }),
	]);

	test("prefix matches first, then by count", () => {
		const typing = parseWord("#sa") as Filter;
		expect(suggest(counts, typing, []).map((s) => s.value)).toEqual([
			"Sale",
			"Wholesale",
		]);
		expect(suggest(counts, parseWord("#") as Filter, [])[0]).toEqual({
			value: "Boxes",
			count: 3,
		});
	});

	test("skips chips already picked", () => {
		const picked = [chip({ field: "tag", value: "boxes", exclude: true })];
		expect(
			suggest(counts, parseWord("#") as Filter, picked).map((s) => s.value),
		).not.toContain("Boxes");
	});
});
