import { describe, expect, test } from "vitest";
import {
	assertAsPacked,
	assertFits,
	ContentsChanged,
	choose,
	driftOf,
	EMPTY_ORDER,
	shortOf,
	WHOLE_LINE,
} from "./packed";

const titles = new Map([
	["L1", "Wrench"],
	["L2", "Knife"],
	["L3", "Tape"],
]);

describe("driftOf", () => {
	test("the same open quantities are no drift", () => {
		const packed = new Map([
			["L1", 2],
			["L2", 1],
		]);
		expect(driftOf(packed, new Map(packed), titles)).toEqual([]);
	});

	test("raised, lowered, removed, and added lines all count", () => {
		const packed = new Map([
			["L1", 2],
			["L2", 1],
		]);
		const open = new Map([
			["L1", 3],
			["L3", 1],
		]);
		expect(driftOf(packed, open, titles)).toEqual([
			{ line: "L1", title: "Wrench", packed: 2, open: 3 },
			{ line: "L2", title: "Knife", packed: 1, open: 0 },
			{ line: "L3", title: "Tape", packed: 0, open: 1 },
		]);
	});

	test("an exact fit throws the drift to show", () => {
		try {
			assertFits("exactly", new Map([["L1", 2]]), new Map([["L1", 1]]), titles);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ContentsChanged);
			expect((err as ContentsChanged).drift).toEqual([
				{ line: "L1", title: "Wrench", packed: 2, open: 1 },
			]);
		}
		// More open than packed isn't a whole order.
		expect(() =>
			assertFits("exactly", new Map([["L1", 2]]), new Map([["L1", 3]]), titles),
		).toThrow(ContentsChanged);
	});
});

describe("a box within what's open", () => {
	const packed = new Map([["L1", 2]]);

	test("leaves extra open units and other lines for later", () => {
		const open = new Map([
			["L1", 5],
			["L2", 1],
		]);
		expect(shortOf(packed, open, titles)).toEqual([]);
		expect(() => assertFits("within", packed, open, titles)).not.toThrow();
	});

	test("refuses a packed line with fewer open than packed, or none", () => {
		expect(shortOf(packed, new Map([["L1", 1]]), titles)).toEqual([
			{ line: "L1", title: "Wrench", packed: 2, open: 1 },
		]);
		expect(() =>
			assertFits("within", packed, new Map([["L2", 3]]), titles),
		).toThrow(ContentsChanged);
	});
});

describe("choosing how many of each line go now", () => {
	const lines = [
		{ orderId: 1, orderLineId: 10, quantity: 3 },
		{ orderId: 1, orderLineId: 11, quantity: 1 },
		{ orderId: 2, orderLineId: 20, quantity: 2 },
	];
	const never = () => false;

	test("every packable unit goes unless lowered", () => {
		expect(choose(lines, [], never)).toEqual({ lines, partial: [] });
	});

	test("a lowered line goes at its count, and 0 leaves it out", () => {
		expect(
			choose(
				lines,
				[
					{ orderLineId: 10, quantity: 1 },
					{ orderLineId: 11, quantity: 0 },
				],
				never,
			),
		).toEqual({
			lines: [{ ...lines[0], quantity: 1 }, lines[2]],
			partial: [1],
		});
		// Lowered to all of it is no lowering.
		expect(
			choose(lines, [{ orderLineId: 20, quantity: 2 }], never).partial,
		).toEqual([]);
	});

	test("refuses counts that aren't packable", () => {
		expect(() =>
			choose(lines, [{ orderLineId: 10, quantity: 4 }], never),
		).toThrow("Only 3");
		expect(() =>
			choose(lines, [{ orderLineId: 10, quantity: -1 }], never),
		).toThrow();
		expect(() =>
			choose(lines, [{ orderLineId: 10, quantity: 1.5 }], never),
		).toThrow();
		expect(() =>
			choose(lines, [{ orderLineId: 99, quantity: 1 }], never),
		).toThrow("nothing left");
		expect(() =>
			choose(
				lines,
				[
					{ orderLineId: 10, quantity: 1 },
					{ orderLineId: 10, quantity: 2 },
				],
				never,
			),
		).toThrow("twice");
	});

	test("an eBay line goes whole or not at all", () => {
		const ebay = (id: number) => id === 1;
		expect(() =>
			choose(lines, [{ orderLineId: 10, quantity: 2 }], ebay),
		).toThrow(WHOLE_LINE);
		// All of it, or none while the order keeps another line, is fine.
		expect(
			choose(lines, [{ orderLineId: 10, quantity: 0 }], ebay).lines,
		).toEqual([lines[1], lines[2]]);
		expect(
			choose(lines, [{ orderLineId: 10, quantity: 3 }], ebay).partial,
		).toEqual([]);
		// The order's other lines still can't all be left out.
		expect(() =>
			choose(
				lines,
				[
					{ orderLineId: 10, quantity: 0 },
					{ orderLineId: 11, quantity: 0 },
				],
				ebay,
			),
		).toThrow(EMPTY_ORDER);
		// Another order's lines still step.
		expect(
			choose(lines, [{ orderLineId: 20, quantity: 1 }], ebay).partial,
		).toEqual([2]);
	});
});

test("assertAsPacked compares with what quick ship showed", () => {
	const line = {
		orderId: 1,
		lineExternalId: "L1",
		productId: null,
		sku: "listing-sku",
		keySku: "WRENCH",
		title: "Wrench",
		quantity: 2,
	};
	expect(() => assertAsPacked([line], "WRENCH×2")).not.toThrow();
	expect(() => assertAsPacked([], "")).toThrow("Nothing");
	expect(() => assertAsPacked([{ ...line, quantity: 1 }], "WRENCH×2")).toThrow(
		"changed since it was packed",
	);
});
