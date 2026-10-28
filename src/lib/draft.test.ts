import { expect, test } from "vitest";
import { followSaved } from "./draft";

test("an untouched draft follows the saved value", () => {
	expect(followSaved({ draft: "4", shown: "4" }, "9")).toEqual({
		draft: "9",
		shown: "9",
	});
});

test("a draft typed over keeps its text when the saved value changes", () => {
	expect(followSaved({ draft: "12", shown: "4" }, "5")).toEqual({
		draft: "12",
		shown: "5",
	});
});

test("an unchanged saved value leaves the state as it was", () => {
	const state = { draft: "12", shown: "4" };
	expect(followSaved(state, "4")).toBe(state);
});
