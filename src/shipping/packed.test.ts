import { describe, expect, test } from "vitest";
import {
	assertAsPacked,
	assertUnchanged,
	ContentsChanged,
	driftOf,
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

	test("assertUnchanged throws the drift to show", () => {
		try {
			assertUnchanged(new Map([["L1", 2]]), new Map([["L1", 1]]), titles);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ContentsChanged);
			expect((err as ContentsChanged).drift).toEqual([
				{ line: "L1", title: "Wrench", packed: 2, open: 1 },
			]);
		}
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
