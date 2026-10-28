import { shopifyAdminOrderUrl } from "#/channels/shopify/admin-url";
import type { channel } from "#/db/schema";

type Channel = (typeof channel.enumValues)[number];

export type AdminPage = { channel: Channel; name: string; url: string };

// The order's pages in its own admins, for anything katasync doesn't do, like
// a return (confirming it arrived, refunding). A TikTok sale relayed through
// Shopify gets both.
export function adminUrls(order: {
	channel: Channel;
	externalId: string;
	marketplaceOrderId: string | null;
}): AdminPage[] {
	const urls: AdminPage[] = [];
	if (order.channel === "shopify") {
		const url = shopifyAdminOrderUrl(order.externalId.split("/").pop() ?? "");
		if (url) urls.push({ channel: "shopify", name: "Shopify", url });
	}
	if (order.channel === "ebay") {
		urls.push({
			channel: "ebay",
			name: "eBay",
			url: `https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(order.externalId)}`,
		});
	}
	if (order.channel === "amazon") {
		urls.push({
			channel: "amazon",
			name: "Amazon",
			url: `https://sellercentral.amazon.com/orders-v3/order/${encodeURIComponent(order.externalId)}`,
		});
	}
	const tiktok = order.marketplaceOrderId?.startsWith("tiktok:")
		? order.marketplaceOrderId.slice("tiktok:".length)
		: null;
	if (tiktok) {
		urls.push({
			channel: "tiktok",
			name: "TikTok",
			url: `https://seller-us.tiktok.com/order/detail?order_no=${encodeURIComponent(tiktok)}`,
		});
	}
	return urls;
}

// Where a return opened on billedBy is handled: that marketplace's page for
// the order, or null when katasync can't link there. Amazon's order page
// doesn't show its returns, so its Manage Returns opens searched to the order,
// over every date.
export function returnPage(
	order: Parameters<typeof adminUrls>[0],
	billedBy: Channel,
): AdminPage | null {
	if (billedBy === "amazon" && order.channel === "amazon") {
		return {
			channel: "amazon",
			name: "Amazon",
			url: `https://sellercentral.amazon.com/gp/returns/list/v2?searchString=${encodeURIComponent(order.externalId)}&orderBy=CreatedDateDesc`,
		};
	}
	return adminUrls(order).find((p) => p.channel === billedBy) ?? null;
}
