// Where an order's label comes from. Marketplaces that sell their own labels
// keep that protection (Amazon's A-to-z, TikTok's shipping). TikTok's are
// bought from katasync; Amazon's still on Seller Central until katasync can
// buy them. Shopify orders leaving the US go through Managed Markets, whose
// customs paperwork only rides on Shopify Shipping labels, bought in Shopify's
// admin. Shippo covers the rest.
// Free of server imports, so pages and the quick ship modal share it.
export type LabelSource = "shippo" | "amazon" | "tiktok" | "shopify";

type OrderRef = {
	channel: string;
	salesChannel: string | null;
	marketplaceOrderId: string | null;
	// The channel's own order id; for Shopify, its GraphQL id.
	externalId: string;
	shipCountry: string | null;
};

// A TikTok Shop sale that reached katasync through Shopify.
export function isShopifyRelayedTiktok(order: {
	salesChannel: string | null;
}): boolean {
	return order.salesChannel === "TikTok";
}

// Every Shopify order leaving the US goes through Managed Markets.
function isManagedMarkets(order: {
	channel: string;
	shipCountry: string | null;
}): boolean {
	const country = order.shipCountry?.trim().toUpperCase();
	return order.channel === "shopify" && !!country && country !== "US";
}

export function labelSource(order: {
	channel: string;
	salesChannel: string | null;
	shipCountry: string | null;
}): LabelSource {
	if (order.channel === "amazon") return "amazon";
	if (order.channel === "tiktok" || isShopifyRelayedTiktok(order))
		return "tiktok";
	if (isManagedMarkets(order)) return "shopify";
	return "shippo";
}

// The page to fulfill an order on, and why, or null when katasync fulfills
// it itself.
export function externalFulfillment(
	order: OrderRef,
): { name: string; url: string; why: string | null } | null {
	const source = labelSource(order);
	if (source === "amazon") {
		const [, id] = order.marketplaceOrderId?.split(":") ?? [];
		return {
			name: "Amazon",
			url: id
				? `https://sellercentral.amazon.com/orders-v3/order/${encodeURIComponent(id)}`
				: "https://sellercentral.amazon.com/orders-v3",
			why: null,
		};
	}
	if (source === "shopify") {
		return {
			name: "Shopify",
			url: shopifyOrderLink(order.externalId),
			why: "International order: Shopify Markets handles customs only on a Shopify Shipping label.",
		};
	}
	return null;
}

// Katasync's redirect to the order in Shopify's admin. The store's handle is
// server-only, so pages link here and the server finishes the address.
export function shopifyOrderLink(externalId: string): string {
	const id = externalId.split("/").pop() ?? "";
	return `/api/shopify/orders/${encodeURIComponent(id)}`;
}
