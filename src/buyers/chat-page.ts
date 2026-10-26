import type { Market } from "#/markets/market";

// Where a conversation is answered on the marketplace's own site. None of
// them links to one chat, so this is the nearest page: the order's page,
// whose contact button opens the chat with that buyer, or without an order
// TikTok's chat inbox, searched by the buyer's name (copied for pasting).
// TikTok's inbox leaves out chats only its assistant answered, so its
// order page comes first.

export type ChatPage = { name: string; url: string; copy: string | null };

const NAMES: Record<Market, string> = {
	shopify: "Shopify",
	tiktok: "TikTok",
	ebay: "eBay",
	amazon: "Amazon",
};

// Shopify buyers are emailed from katasync, with no chat page: none.
const pages: Record<Market, (orderRef: string | null) => string | null> = {
	shopify: () => null,
	tiktok: (o) =>
		o
			? `https://seller-us.tiktok.com/order/detail?order_no=${encodeURIComponent(o)}`
			: "https://seller-us.tiktok.com/chat/inbox/current",
	ebay: (o) =>
		o
			? `https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(o)}`
			: "https://mesg.ebay.com/mesgweb/ViewMessages/0",
	amazon: (o) =>
		o
			? `https://sellercentral.amazon.com/orders-v3/order/${encodeURIComponent(o)}`
			: "https://sellercentral.amazon.com/messaging/inbox",
};

export function chatPage(t: {
	market: Market;
	orderRef: string | null;
	buyerName: string | null;
}): ChatPage | null {
	const url = pages[t.market](t.orderRef);
	if (!url) return null;
	return {
		name: NAMES[t.market],
		url,
		copy: t.market === "tiktok" && !t.orderRef ? t.buyerName : null,
	};
}
