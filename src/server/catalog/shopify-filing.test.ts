import { describe, expect, test } from "vitest";
import { type FilingRow, shopifyFiling } from "./shopify-filing";

const listing = (over: Partial<FilingRow>): FilingRow => ({
	productId: 1,
	tags: [],
	productType: null,
	vendor: null,
	status: "ACTIVE",
	goneAt: null,
	...over,
});
const ended = new Date("2026-10-01T00:00:00Z");

describe("how Shopify files a product", () => {
	test("an ended listing doesn't make the product active", () => {
		const filing = shopifyFiling([
			listing({ status: "ACTIVE", goneAt: ended }),
			listing({ status: "DRAFT" }),
		]);
		expect(filing.get(1)?.status).toBe("DRAFT");
	});

	test("a product with only ended listings has no current status", () => {
		const filing = shopifyFiling([
			listing({ status: "ACTIVE", goneAt: ended, tags: ["old"], vendor: "V" }),
		]);
		expect(filing.get(1)).toMatchObject({
			status: null,
			tags: new Set(["old"]),
			vendor: "V",
		});
	});

	test("a live listing outranks a draft", () => {
		const filing = shopifyFiling([
			listing({ status: "DRAFT" }),
			listing({ status: "ACTIVE" }),
		]);
		expect(filing.get(1)?.status).toBe("ACTIVE");
	});

	test("a listing that's still on the channel keeps its own status", () => {
		const filing = shopifyFiling([listing({ status: "ARCHIVED" })]);
		expect(filing.get(1)?.status).toBe("ARCHIVED");
	});
});
