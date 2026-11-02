import { describe, expect, it } from "vitest";
import { returnPage } from "./admin-urls";

describe("returnPage", () => {
	it("opens Amazon's Manage Returns searched to the order", () => {
		expect(
			returnPage(
				{ channel: "amazon", externalId: "114-1-2", marketplaceOrderId: null },
				"amazon",
			)?.url,
		).toBe(
			"https://sellercentral.amazon.com/gp/returns/list/v2?searchString=114-1-2&orderBy=CreatedDateDesc",
		);
	});

	it("opens TikTok's Manage Returns searched to the order, on Shopify or not", () => {
		for (const channel of ["shopify", "tiktok"] as const) {
			expect(
				returnPage(
					{
						channel,
						externalId: "gid://shopify/Order/9",
						marketplaceOrderId: "tiktok:5770",
					},
					"tiktok",
				)?.url,
			).toBe(
				"https://seller-us.tiktok.com/order/return?search_numbers=5770&tab=100",
			);
		}
	});
});
