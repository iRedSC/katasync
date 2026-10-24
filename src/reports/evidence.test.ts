import { describe, expect, it } from "vitest";
import { type EvidenceGroup, feeEvidence, foldEvidence } from "./evidence";

describe("feeEvidence", () => {
	it("never calls age alone settled", () => {
		expect(feeEvidence({ feesStatus: "final", settled: false })).toBe(
			"aged_out",
		);
	});

	it("calls fees settled only when the marketplace said so", () => {
		expect(feeEvidence({ feesStatus: "final", settled: true })).toBe("settled");
		expect(feeEvidence({ feesStatus: "reported", settled: true })).toBe(
			"settled",
		);
	});

	it("keeps reported and estimated apart from both", () => {
		expect(feeEvidence({ feesStatus: "reported", settled: false })).toBe(
			"reported",
		);
		expect(feeEvidence({ feesStatus: "estimated", settled: false })).toBe(
			"estimated",
		);
		expect(feeEvidence({ feesStatus: "estimated", settled: true })).toBe(
			"estimated",
		);
	});
});

describe("foldEvidence", () => {
	const group = (g: Partial<EvidenceGroup>): EvidenceGroup => ({
		soldOn: "shopify",
		feesStatus: "reported",
		settled: false,
		labelsStatus: "known",
		costKnown: true,
		taxRead: true,
		orders: 1,
		fees: 1,
		...g,
	});

	it("sums each kind of evidence on its own, per marketplace", () => {
		const rows = foldEvidence([
			group({ soldOn: "tiktok", feesStatus: "final", settled: true, fees: 4 }),
			group({ feesStatus: "final", orders: 2, fees: 3.1 }),
			group({ feesStatus: "final", settled: true, fees: 0.2 }),
			group({ feesStatus: "estimated", fees: 0.59, costKnown: false }),
			group({ labelsStatus: "missing", taxRead: false }),
		]);
		expect(rows.map((r) => r.soldOn)).toEqual(["shopify", "tiktok"]);
		const [shop, tiktok] = rows;
		expect(shop.fees).toEqual({
			settled: { orders: 1, amount: 0.2 },
			reported: { orders: 1, amount: 1 },
			aged_out: { orders: 2, amount: 3.1 },
			estimated: { orders: 1, amount: 0.59 },
		});
		expect(shop).toMatchObject({
			orders: 5,
			costUnknown: 1,
			labelsMissing: 1,
			taxUnknown: 1,
		});
		expect(tiktok.fees.settled).toEqual({ orders: 1, amount: 4 });
		expect(tiktok.fees.aged_out.orders).toBe(0);
	});
});
