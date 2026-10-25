import { describe, expect, test } from "vitest";
import { type ChatOrder, chatWay } from "./chat-way";
import { firstMessageFailure, tiktokStartFailure } from "./start-chat";
import { Refused, Unsure } from "./states";

const now = new Date("2026-10-25T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const order = (o: Partial<ChatOrder>): ChatOrder => ({
	channel: "tiktok",
	marketplaceOrderId: null,
	placedAt: daysAgo(3),
	returnAsked: false,
	threads: [],
	amazonPage: null,
	...o,
});

describe("chatWay", () => {
	test("a conversation katasync keeps opens, the latest on the buyer's marketplace", () => {
		const way = chatWay(
			order({
				placedAt: daysAgo(200),
				threads: [
					{ id: 1, market: "tiktok", lastAt: daysAgo(10) },
					{ id: 2, market: "tiktok", lastAt: daysAgo(2) },
					{ id: 3, market: "amazon", lastAt: daysAgo(1) },
				],
			}),
			now,
		);
		expect(way).toEqual({ kind: "open", threadId: 2 });
	});

	test("TikTok starts within 60 days of the order", () => {
		expect(chatWay(order({ placedAt: daysAgo(59) }), now)).toEqual({
			kind: "start",
			market: "tiktok",
		});
	});

	test("TikTok refuses past 60 days, saying why", () => {
		expect(chatWay(order({ placedAt: daysAgo(61) }), now)).toEqual({
			kind: "refused",
			reason: "TikTok allows this within 60 days of the order",
		});
	});

	test("a return or refund asked for lets TikTok start any time", () => {
		expect(
			chatWay(order({ placedAt: daysAgo(120), returnAsked: true }), now).kind,
		).toBe("start");
	});

	test("a TikTok sale Shopify relayed is TikTok's", () => {
		expect(
			chatWay(
				order({ channel: "shopify", marketplaceOrderId: "tiktok:577" }),
				now,
			),
		).toEqual({ kind: "start", market: "tiktok" });
	});

	test("eBay starts with the first message, at any age", () => {
		expect(
			chatWay(order({ channel: "ebay", placedAt: daysAgo(400) }), now),
		).toEqual({ kind: "start", market: "ebay" });
	});

	test("Amazon goes to Seller Central unless a relay thread exists", () => {
		const url = "https://sellercentral.amazon.com/orders-v3/order/1";
		expect(chatWay(order({ channel: "amazon", amazonPage: url }), now)).toEqual(
			{ kind: "elsewhere", name: "Seller Central", url },
		);
		expect(
			chatWay(
				order({
					channel: "amazon",
					amazonPage: url,
					threads: [{ id: 9, market: "amazon", lastAt: null }],
				}),
				now,
			),
		).toEqual({ kind: "open", threadId: 9 });
	});

	test("a Shopify buyer can't be started", () => {
		expect(chatWay(order({ channel: "shopify" }), now).kind).toBe("refused");
	});
});

describe("outcomes", () => {
	test("TikTok's plain no is refused; anything else failed", () => {
		expect(tiktokStartFailure(new Refused("TikTok: not allowed"))).toEqual({
			kind: "refused",
			reason: "TikTok: not allowed",
		});
		expect(tiktokStartFailure(new Error("socket hang up"))).toEqual({
			kind: "failed",
			reason: "socket hang up",
		});
	});

	test("a first eBay message is refused only on a plain no", () => {
		expect(firstMessageFailure(new Refused("eBay answered 400"))).toEqual({
			kind: "refused",
			reason: "eBay answered 400",
		});
		for (const e of [new Unsure("eBay answered 503"), new Error("timeout")])
			expect(firstMessageFailure(e).kind).toBe("unsure");
	});
});
