import { expect, test } from "vitest";
import { chatPage } from "./chat-page";

test("each conversation opens where it's answered", () => {
	expect(
		chatPage({ market: "tiktok", orderRef: "577", buyerName: "drywaller7" }),
	).toEqual({
		name: "TikTok",
		url: "https://seller-us.tiktok.com/order/detail?order_no=577",
		copy: null,
	});
	expect(
		chatPage({ market: "tiktok", orderRef: null, buyerName: "drywaller7" }),
	).toEqual({
		name: "TikTok",
		url: "https://seller-us.tiktok.com/chat/inbox/current",
		copy: "drywaller7",
	});
	expect(
		chatPage({ market: "amazon", orderRef: "113-1-2", buyerName: "Al" })?.url,
	).toBe("https://sellercentral.amazon.com/orders-v3/order/113-1-2");
	expect(
		chatPage({ market: "ebay", orderRef: null, buyerName: "Al" }),
	).toMatchObject({ copy: null, url: expect.stringContaining("mesg.ebay") });
	expect(
		chatPage({ market: "shopify", orderRef: "1", buyerName: null }),
	).toBeNull();
});
