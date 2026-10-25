import type { Market } from "#/markets/market";

// Whether staff can write to an order's buyer from its page, and how: a
// conversation katasync already keeps opens; TikTok lets a shop open one
// before anything is written; eBay's begins with its first message; Amazon
// only takes a first message on Seller Central (Contact Buyer). Shared by
// the server and the page.

// TikTok lets a shop start a chat this long after the order, and any time
// once a return or refund was asked for.
export const TIKTOK_START_WITHIN_MS = 60 * 86_400_000;

export type ChatWay =
	| { kind: "open"; threadId: number }
	| { kind: "start"; market: "tiktok" | "ebay" }
	| { kind: "elsewhere"; name: string; url: string }
	| { kind: "refused"; reason: string };

export type ChatOrder = {
	channel: Market;
	marketplaceOrderId: string | null;
	placedAt: Date;
	// A return or refund was asked for, ever.
	returnAsked: boolean;
	// The buyer conversations katasync keeps about the order.
	threads: { id: number; market: Market; lastAt: Date | null }[];
	// The order on Seller Central, for an Amazon order.
	amazonPage: string | null;
};

// Where the buyer really bought: a TikTok sale Shopify relayed is TikTok's.
export function buyerMarket(
	o: Pick<ChatOrder, "channel" | "marketplaceOrderId">,
) {
	return o.marketplaceOrderId?.startsWith("tiktok:") ? "tiktok" : o.channel;
}

export function chatWay(o: ChatOrder, now: Date): ChatWay {
	const market = buyerMarket(o);
	const latest = o.threads
		.filter((t) => t.market === market)
		.sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0))[0];
	if (latest) return { kind: "open", threadId: latest.id };
	switch (market) {
		case "tiktok":
			return o.returnAsked ||
				now.getTime() - o.placedAt.getTime() <= TIKTOK_START_WITHIN_MS
				? { kind: "start", market }
				: {
						kind: "refused",
						reason: "TikTok allows this within 60 days of the order",
					};
		case "ebay":
			return { kind: "start", market };
		case "amazon":
			return o.amazonPage
				? { kind: "elsewhere", name: "Seller Central", url: o.amazonPage }
				: { kind: "refused", reason: "Amazon takes this on Seller Central" };
		case "shopify":
			return {
				kind: "refused",
				reason: "katasync can't write to Shopify buyers yet",
			};
	}
}

// What asking to write to the buyer came to. None of these sends anything.
export type ChatOpening =
	| { kind: "opened"; threadId: number }
	// TikTok's conversation, now kept in katasync, empty of anything of ours.
	| { kind: "started"; threadId: number }
	// eBay: no conversation until the first message, which starts it.
	| { kind: "compose"; to: string }
	| { kind: "refused"; reason: string }
	| { kind: "failed"; reason: string };

// What sending the first eBay message came to. Both sent kinds mean the
// buyer has it; unsure may have gone, so it's never sent again blind.
export type FirstMessage =
	| { kind: "sent"; threadId: number }
	// Sent, but eBay doesn't list its conversation yet: the Inbox reads it in.
	| { kind: "sent_unlisted" }
	| { kind: "refused"; reason: string }
	| { kind: "unsure"; reason: string };
