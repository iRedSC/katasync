import { expect, test } from "vitest";
import { describeRebill, rebillReason } from "./rebill-reason";

test("reads the package as billed and as declared from a charge correction", () => {
	const reason = rebillReason(
		"Shipping Charge Correction Ground: Billed Weight (lb): 40.0 Declared Weight (oz): 74.0 Billed Dimensions (in): 49.0 x 5.0 x 5.0 Declared Dimensions (in): 47.99 x 4.02 x 4.02",
	);
	expect(reason).toMatchObject({ kind: "correction" });
	if (reason.kind !== "correction") return;
	expect(reason.billed.weightGrams).toBeCloseTo(18143.69, 1);
	expect(reason.declared.weightGrams).toBeCloseTo(2097.86, 1);
	expect(reason.billed.box).toEqual([1244.6, 127, 127]);
	expect(reason.declared.box.map((mm) => Math.round(mm))).toEqual([
		1219, 102, 102,
	]);
	expect(describeRebill(reason)).toBe(
		"Billed as 40 lb, 49 × 5 × 5 in; declared 4 lb 10 oz, 48 × 4 × 4 in",
	);
});

test("keeps a surcharge, or a correction in a shape not seen yet, as Shippo wrote it", () => {
	expect(rebillReason(" Addl. Handling longest side ")).toEqual({
		kind: "charge",
		text: "Addl. Handling longest side",
	});
	const odd =
		"Shipping Charge Correction Ground: Billed Weight (st): 3 Declared Weight (oz): 74.0 Billed Dimensions (in): 49 x 5 x 5 Declared Dimensions (in): 48 x 4 x 4";
	expect(rebillReason(odd)).toEqual({ kind: "charge", text: odd });
});
