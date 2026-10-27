import { describe, expect, it } from "vitest";
import { lineNumbers } from "./line-numbers";

describe("lineNumbers", () => {
	it("numbers every line of a draft in order", () => {
		const lines = [
			{ id: 7, sentQuantity: null },
			{ id: 3, sentQuantity: null },
		];
		expect([...lineNumbers(lines, false)]).toEqual([
			[7, 1],
			[3, 2],
		]);
	});

	it("skips lines the supplier wasn't sent, without renumbering the rest", () => {
		const lines = [
			{ id: 1, sentQuantity: 4 },
			{ id: 2, sentQuantity: 0 },
			{ id: 3, sentQuantity: null },
			{ id: 4, sentQuantity: 2 },
		];
		expect([...lineNumbers(lines, true)]).toEqual([
			[1, 1],
			[2, 2],
			[4, 3],
		]);
	});
});
