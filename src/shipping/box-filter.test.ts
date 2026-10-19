import { describe, expect, test } from "vitest";
import { boxLabel, filterBoxes, typedSize } from "./box-filter";

const box = (name: string | null, l: number, w: number, h: number) => ({
	name,
	lengthMm: Math.round(l * 25.4),
	widthMm: Math.round(w * 25.4),
	heightMm: Math.round(h * 25.4),
});
const flat = box(null, 12, 9, 4);
const tall = box(null, 14, 9, 12);
const mailer = box("Bubble mailer", 12, 9, 1);
const all = [flat, tall, mailer];

describe("finding a box", () => {
	test("numbers are sides in order, each the start of that side", () => {
		expect(filterBoxes(all, "1")).toEqual(all);
		expect(filterBoxes(all, "12")).toEqual([flat, mailer]);
		expect(filterBoxes(all, "12 9 4")).toEqual([flat]);
		expect(filterBoxes(all, "12x9x1")).toEqual([mailer]);
		expect(filterBoxes(all, "9")).toEqual([]);
	});

	test("words find the name", () => {
		expect(filterBoxes(all, "bub")).toEqual([mailer]);
		expect(filterBoxes(all, "mailer 12")).toEqual([mailer]);
		expect(filterBoxes(all, "mailer 14")).toEqual([]);
	});

	test("the box of exactly the typed size comes first", () => {
		const longer = box(null, 12, 9, 45);
		expect(filterBoxes([longer, flat], "12 9 4")).toEqual([flat, longer]);
	});

	test("a size is three sides and nothing else", () => {
		expect(typedSize("12 9 4")).toEqual({
			lengthMm: 305,
			widthMm: 229,
			heightMm: 102,
		});
		expect(typedSize("12 9")).toBeNull();
		expect(typedSize("12 9 4 mailer")).toBeNull();
		expect(typedSize("12 0 4")).toBeNull();
	});

	test("labels lead with the name when there is one", () => {
		expect(boxLabel(flat)).toBe("12 × 9 × 4");
		expect(boxLabel(mailer)).toBe("Bubble mailer 12 × 9 × 1");
	});
});
