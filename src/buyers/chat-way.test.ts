import { describe, expect, test } from "vitest";
import {
	attemptOutcome,
	type ChatOrder,
	chatWay,
	draftFits,
	marketRef,
} from "./chat-way";
import { firstMessageFailure } from "./first-message";
import { pickThread, tiktokStartFailure } from "./start-chat";
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

describe("attempts", () => {
	const base = { threadId: null, error: null, createdAt: now };
	test("each written-down try reads back as its outcome", () => {
		expect(attemptOutcome({ ...base, status: "sending" }, now)).toEqual({
			kind: "sending",
		});
		expect(
			attemptOutcome({ ...base, status: "sent", threadId: 4 }, now),
		).toEqual({ kind: "sent", threadId: 4 });
		expect(attemptOutcome({ ...base, status: "sent" }, now)).toEqual({
			kind: "sent_unlisted",
		});
		expect(
			attemptOutcome({ ...base, status: "unsure", error: "eBay 503" }, now),
		).toEqual({ kind: "unsure", reason: "eBay 503" });
	});

	test("a try cut off mid-send turns unsure", () => {
		const later = new Date(now.getTime() + 3 * 60_000);
		expect(attemptOutcome({ ...base, status: "sending" }, later).kind).toBe(
			"unsure",
		);
	});
});

describe("order in view", () => {
	test("a relayed TikTok sale is named by TikTok's ID", () => {
		expect(
			marketRef({
				channel: "shopify",
				externalId: "gid://shopify/Order/1",
				marketplaceOrderId: "tiktok:577",
			}),
		).toBe("577");
		expect(
			marketRef({
				channel: "ebay",
				externalId: "12-1",
				marketplaceOrderId: "ebay:12-1",
			}),
		).toBe("12-1");
	});

	test("a suggestion fits only the order it was written about", () => {
		expect(draftFits({ forOrder: "A" }, "A")).toBe(true);
		expect(draftFits({ forOrder: "A" }, "B")).toBe(false);
	});
});

describe("pickThread", () => {
	// A repeat buyer: latest first, as the query lists them.
	const kept = [
		{ id: 3, orderRef: null, itemRef: "item-9" },
		{ id: 2, orderRef: null, itemRef: "item-1" },
		{ id: 1, orderRef: "12-1", itemRef: "item-1" },
	];
	test("the thread about the order comes first", () => {
		expect(pickThread(kept, "12-1", "item-1")?.id).toBe(1);
	});
	test("then the one about its listing", () => {
		expect(pickThread(kept, "12-2", "item-1")?.id).toBe(2);
	});
	test("then the buyer's latest", () => {
		expect(pickThread(kept, "12-3", "item-5")?.id).toBe(3);
		expect(pickThread([], "12-3", null)).toBeNull();
	});
});
