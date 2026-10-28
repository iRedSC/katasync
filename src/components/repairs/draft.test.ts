import { expect, test } from "vitest";
import { follow, start, toSave, typed } from "./draft";

test("untouched, it follows the value as it changes", () => {
	const d = follow(start(1, "A"), 1, "B");
	expect(d.value).toBe("B");
	expect(toSave(d, "B")).toBeNull();
});

test("focusing and leaving a stale field saves nothing", () => {
	// The field loaded A; the repair became B elsewhere; staff just click in
	// and out. B must not be overwritten with A.
	const d = follow(start(1, "A"), 1, "B");
	expect(toSave(d, "B")).toBeNull();
});

test("typed words stay when the value changes, and are saved", () => {
	const d = follow(typed(start(1, "A"), "mine"), 1, "B");
	expect(d.value).toBe("mine");
	expect(toSave(d, "B")).toBe("mine");
});

test("typing the value back is not an edit to save", () => {
	const d = typed(start(1, "A"), "A");
	expect(toSave(d, "A")).toBeNull();
});

test("once the typed words are the value, the field follows again", () => {
	const saved = follow(typed(start(1, "A"), "mine"), 1, "mine");
	expect(saved.edited).toBe(false);
	expect(follow(saved, 1, "later").value).toBe("later");
});

test("another record starts over", () => {
	const d = follow(typed(start(1, "A"), "mine"), 2, "Other");
	expect(d.value).toBe("Other");
	expect(d.edited).toBe(false);
});

test("an unchanged value gives back the same draft", () => {
	const d = start(1, "A");
	expect(follow(d, 1, "A")).toBe(d);
});
