import { describe, expect, test } from "vitest";
import { type StoppedProduct, tiktokProblems } from "./tiktok-standing";

const failed = (
	id: string,
	sellerSku: string | null,
	skuId: string,
	suggestion: string,
): StoppedProduct => ({
	status: "FAILED",
	id,
	title: `Product ${id}`,
	skuId,
	sellerSku,
	detail: {
		audit_failed_reasons: [
			{
				position: "Variation",
				reasons: ["Low price"],
				suggestions: [suggestion],
			},
		],
	},
});

describe("TikTok stopped products", () => {
	test("blank or shared seller SKUs keep every product, a blank one named by its ID", () => {
		const [problem] = tiktokProblems([
			failed("1", "", "sku-1", "Raise it."),
			failed("2", "   ", "sku-2", "Raise it."),
			failed("3", "COL", "sku-3", "Raise it."),
			failed("4", "COL", "sku-4", "Raise it."),
		]);
		expect(problem.items.map((i) => [i.listingId, i.ref])).toEqual([
			["sku-1", "1"],
			["sku-2", "2"],
			["sku-3", "COL"],
			["sku-4", "COL"],
		]);
	});

	test("repeated evidence for one product keeps each of its corrections", () => {
		const [problem] = tiktokProblems([
			{
				status: "FAILED",
				id: "1",
				title: "Mug",
				skuId: "sku-1",
				sellerSku: "MUG",
				detail: {
					audit_failed_reasons: [
						{
							position: "Title",
							reasons: ["Low price"],
							suggestions: ["Fix the title."],
						},
						{
							position: "Price",
							reasons: ["Low price"],
							suggestions: ["Raise the price."],
						},
					],
				},
			},
		]);
		expect(problem.items).toHaveLength(1);
		expect(problem.items[0]).toEqual(
			expect.objectContaining({ listingId: "sku-1", ref: "MUG" }),
		);
		expect(problem.items[0].detail).toContain("Raise the price.");
		expect(problem.items[0].detail).toContain("In price");
	});
});
