import { describe, expect, test } from "vitest";
import { countSteps } from "./unit-count";

const line = (
	orderId: number,
	quantity: number,
	packable: number,
	whole = false,
) => ({
	orderId,
	quantity,
	packable,
	whole,
});

describe("a line's count buttons", () => {
	test("step one unit at a time", () => {
		const a = line(1, 2, 3);
		expect(countSteps(a, [a])).toEqual({ lower: 1, raise: 3 });
		const one = line(1, 1, 3);
		// The order's last unit stays.
		expect(countSteps(one, [one])).toEqual({ lower: null, raise: 2 });
	});

	test("an eBay line toggles between all and none", () => {
		const a = line(1, 3, 3, true);
		const b = line(1, 1, 1, true);
		expect(countSteps(a, [a, b])).toEqual({ lower: 0, raise: null });
		const off = line(1, 0, 3, true);
		expect(countSteps(off, [off, b])).toEqual({ lower: null, raise: 3 });
		// Its order keeps at least one line: the last one can't go to 0.
		expect(countSteps(a, [a])).toEqual({ lower: null, raise: null });
		expect(countSteps(a, [a, line(1, 0, 2, true)]).lower).toBeNull();
		// Another order's lines don't keep this one in.
		expect(countSteps(a, [a, line(2, 4, 4)]).lower).toBeNull();
	});
});
