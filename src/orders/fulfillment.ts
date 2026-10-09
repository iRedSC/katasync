// Where an order's label comes from. Marketplaces that sell their own labels
// keep that protection (Amazon's A-to-z, TikTok's shipping), so those orders
// are fulfilled on the marketplace; Shippo covers the rest in katasync.
// Free of server imports, so pages and the quick ship modal share it.
export type LabelSource = "shippo" | "amazon" | "tiktok";

type OrderRef = {
	channel: string;
	salesChannel: string | null;
	marketplaceOrderId: string | null;
};

export function labelSource(order: {
	channel: string;
	salesChannel: string | null;
}): LabelSource {
	if (order.channel === "amazon") return "amazon";
	if (order.salesChannel === "TikTok") return "tiktok";
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
	if (source === "tiktok") {
		return {
			name: "TikTok",
			url: id
				? `https://seller-us.tiktok.com/order/detail?order_no=${encodeURIComponent(id)}`
				: "https://seller-us.tiktok.com/order",
		};
	}
	return null;
}
