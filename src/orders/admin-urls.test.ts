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
});
