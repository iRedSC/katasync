import { describe, expect, it } from "vitest";
import { pageHotkeys, pages } from "./pages";

describe("page shortcuts", () => {
	it("gives every page its own", () => {
		expect(() => pageHotkeys(pages, () => {})).not.toThrow();
		expect(new Set(pages.map((p) => p.keys)).size).toBe(pages.length);
	});

	it("refuses two pages sharing one", () => {
		expect(() =>
			pageHotkeys(
				[
					{ keys: "g b", label: "A" },
					{ keys: "g b", label: "B" },
				],
				() => {},
			),
		).toThrow('B shares the shortcut "g b"');
	});

	it("runs the page it names", () => {
		const went: string[] = [];
		pageHotkeys(pages, (p) => went.push(p.to))["g x"]?.();
		expect(went).toEqual(["/reconciliation"]);
	});
});
