import { describe, expect, test } from "vitest";
import { formPackage, packageFormUrl } from "./amazon-form";

const box = (weightGrams: number, hazmat = false) => ({
	// 12 × 9 × 4.5 in.
	dims: { lengthMm: 304.8, widthMm: 228.6, heightMm: 114.3 },
	weightGrams,
	hazmat,
});

describe("formPackage", () => {
	test("gives inches, and whole pounds with the ounces left over", () => {
		// 2 lb 3.5 oz.
		expect(formPackage(box(1006))).toEqual({
			v: 1,
			in: [12, 9, 4.5],
			lb: 2,
			oz: 3.5,
			hazmat: false,
		});
	});

	test("keeps a box under a pound in ounces", () => {
		expect(formPackage(box(227))).toMatchObject({ lb: 0, oz: 8 });
	});

	test("carries ounces that round up to a pound into the pounds", () => {
		// 15.98 oz shows as 16.0 oz here, so it's 1 lb there, never 0 lb 16 oz.
		expect(formPackage(box(453))).toMatchObject({ lb: 1, oz: 0 });
	});

	test("marks aerosols", () => {
		expect(formPackage(box(500, true)).hazmat).toBe(true);
	});
});

test("packageFormUrl puts the box after the #, where Amazon isn't sent it", () => {
	const url = new URL(
		packageFormUrl(
			"https://sellercentral.amazon.com/orders-v3/order/111-1/buy-shipping",
			box(1006),
		),
	);
	expect(url.pathname).toBe("/orders-v3/order/111-1/buy-shipping");
	expect(url.search).toBe("");
	expect(
		JSON.parse(decodeURIComponent(url.hash.slice("#katasync=".length))),
	).toEqual(formPackage(box(1006)));
});
