import { describe, expect, test } from "vitest";
import {
	emptyEntry,
	entryQuery,
	isPartial,
	reopenSide,
	type SizeEntry,
	sizeEntry,
	startFrom,
	typeName,
	typeSize,
} from "./box-entry";

const size = (sides: string[], typing = ""): SizeEntry => ({
	kind: "size",
	sides,
	typing,
});

describe("typing a box", () => {
	test("space, x, and comma lock in a side", () => {
		expect(typeSize(size([]), "12")).toEqual(size([], "12"));
		expect(typeSize(size([]), "12 ")).toEqual(size(["12"]));
		expect(typeSize(size(["12"]), "9x")).toEqual(size(["12", "9"]));
		expect(typeSize(size(["12", "9"]), "4,")).toEqual(size(["12", "9", "4"]));
	});

	test("a space with nothing typed locks in nothing", () => {
		expect(typeSize(size(["12"]), " ")).toEqual(size(["12"]));
	});

	test("a pasted size fills every side", () => {
		expect(typeSize(size([]), "12 x 9 x 4.5")).toEqual(
			size(["12", "9"], "4.5"),
		);
	});

	test("nothing past the third side", () => {
		expect(typeSize(size(["12", "9", "4"]), "7")).toEqual(
			size(["12", "9", "4"]),
		);
	});

	test("a letter turns it into a name search, keeping the sides", () => {
		expect(typeSize(size([]), "m")).toEqual({ kind: "name", text: "m" });
		expect(typeSize(size(["12"]), "m")).toEqual({ kind: "name", text: "12 m" });
	});

	test("backspace on an empty side reopens the one before", () => {
		expect(reopenSide(size(["12", "9"]))).toEqual(size(["12"], "9"));
		expect(reopenSide(size(["12"], "9"))).toBeNull();
		expect(reopenSide(emptyEntry)).toBeNull();
	});

	test("clearing a name search goes back to a size", () => {
		expect(typeName("")).toEqual(emptyEntry);
	});

	test("the filter sees sides and the side being typed", () => {
		expect(entryQuery(size(["12", "9"], "4"))).toBe("12 9 4");
		expect(entryQuery({ kind: "name", text: "mailer" })).toBe("mailer");
	});

	test("partial is something typed short of three sides", () => {
		expect(isPartial(emptyEntry)).toBe(false);
		expect(isPartial(size(["12"]))).toBe(true);
		expect(isPartial(size(["12", "9"], "4"))).toBe(false);
		expect(isPartial(size(["12", "9", "4"]))).toBe(false);
		expect(isPartial({ kind: "name", text: "du" })).toBe(true);
	});
});

describe("startFrom", () => {
	test("a saved box is highlighted with nothing typed", () => {
		expect(startFrom({ id: 4 }, [12, 9, 4])).toEqual({
			entry: emptyEntry,
			picked: "box:4",
		});
	});

	test("a size used without a saved box starts typed in", () => {
		expect(startFrom(null, [12, 9, 4])).toEqual({
			entry: sizeEntry([12, 9, 4]),
			picked: null,
		});
	});

	test("contents never shipped start from nothing, not the last contents' box", () => {
		expect(startFrom(null, null)).toEqual({ entry: emptyEntry, picked: null });
	});
});
