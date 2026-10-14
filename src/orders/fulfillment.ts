// Where an order's label comes from. Marketplaces that sell their own labels
// keep that protection (Amazon's A-to-z, TikTok's shipping). TikTok's are
// bought from katasync; Amazon's still on Seller Central until katasync can
// buy them. Shippo covers the rest.
// Free of server imports, so pages and the quick ship modal share it.
export type LabelSource = "shippo" | "amazon" | "tiktok";

type OrderRef = {
	channel: string;
	salesChannel: string | null;
	marketplaceOrderId: string | null;
};

// A TikTok Shop sale that reached katasync through Shopify.
export function isShopifyRelayedTiktok(order: {
	salesChannel: string | null;
}): boolean {
	return order.salesChannel === "TikTok";
}

export function labelSource(order: {
	channel: string;
	salesChannel: string | null;
}): LabelSource {
	if (order.channel === "amazon") return "amazon";
	if (order.channel === "tiktok" || isShopifyRelayedTiktok(order))
		return "tiktok";
	return "shippo";
}

// The marketplace page to fulfill an order on, or null when katasync
// fulfills it itself.
export function externalFulfillment(
	order: OrderRef,
): { name: string; url: string } | null {
	const source = labelSource(order);
	const [, id] = order.marketplaceOrderId?.split(":") ?? [];
	if (source === "amazon") {
		return {
			name: "Amazon",
			url: id
				? `https://sellercentral.amazon.com/orders-v3/order/${encodeURIComponent(id)}`
				: "https://sellercentral.amazon.com/orders-v3",
		};
	}
	return null;
}
