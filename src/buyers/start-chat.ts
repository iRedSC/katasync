import { and, desc, eq, or, sql } from "drizzle-orm";
import { detailPage, shopCipher, tiktokApi } from "#/channels/tiktok";
import type { Db } from "#/db/client";
import { buyerThreads } from "#/db/schema";
import {
	type ChatOrderRow,
	chatOrder,
	type EbayOrder,
	isEbay,
} from "./chat-order";
import { buyerMarket, type ChatOpening, marketRef } from "./chat-way";
import { ebayOrderBuyer, keepEbayConversationWith } from "./ebay-messages";
import { lastTry } from "./first-message";
import { Refused } from "./states";
import { ensureThread } from "./threads";
import {
	openTiktokConversation,
	readStartedTiktokThread,
} from "./tiktok-messages";

// Writing to an order's buyer from its page when they haven't written first
// (chat-way.ts says when it's offered). Opening a conversation sends
// nothing: on TikTok it's opened and kept as a thread, answered through the
// usual reply path (send.ts); on eBay a conversation only exists once a
// message is in it, so the first message starts it (first-message.ts).
// Nothing here moves an existing thread to another order: the page passes
// the order it's opened from along with the thread. Server only.

const why = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// A failure to open a TikTok conversation: TikTok's plain no (outside its
// limits on the order), or anything else, which may pass if tried again.
export function tiktokStartFailure(error: unknown): ChatOpening {
	return error instanceof Refused
		? { kind: "refused", reason: error.message }
		: { kind: "failed", reason: why(error) };
}

export async function openChat(db: Db, orderId: number): Promise<ChatOpening> {
	const o = await chatOrder(db, orderId);
	const market = buyerMarket(o);
	try {
		if (market === "tiktok") return await openTiktok(db, o);
		if (isEbay(o) && market === "ebay") return await openEbay(db, o);
	} catch (error) {
		return { kind: "failed", reason: why(error) };
	}
	return {
		kind: "refused",
		reason: `katasync can't start ${market} conversations`,
	};
}

async function openTiktok(db: Db, o: ChatOrderRow): Promise<ChatOpening> {
	const ref = marketRef(o);
	// Older orders, and those Shopify relayed, may not have the buyer yet.
	const buyer =
		o.buyerId ??
		detailPage
			.assert(
				await tiktokApi("/order/202309/orders", {
					shop_cipher: await shopCipher(),
					ids: ref,
				}),
			)
			.orders?.find((d) => d.id === ref)?.user_id ??
		null;
	if (!buyer)
		return { kind: "failed", reason: "TikTok didn't say who the buyer is" };
	let conversationId: string;
	try {
		conversationId = await openTiktokConversation(buyer);
	} catch (error) {
		return tiktokStartFailure(error);
	}
	// TikTok keeps one conversation per buyer. A new one is about this order;
	// one kept already stays about the order it was.
	const thread = await ensureThread(db, {
		market: "tiktok",
		externalId: conversationId,
		subject: "TikTok Shop chat",
		orderRef: ref,
	});
	// What TikTok already put in it; the thread works without it.
	await readStartedTiktokThread(db, thread.id).catch(() => {});
	return { kind: "started", threadId: thread.id };
}

type Kept = { id: number; orderRef: string | null; itemRef: string | null };

// Which of an eBay buyer's threads to open for an order, latest first: one
// about the order, then one about its listing, then their latest.
export function pickThread(
	kept: Kept[],
	orderRef: string,
	itemId: string | null,
) {
	return (
		kept.find((t) => t.orderRef === orderRef) ??
		(itemId ? kept.find((t) => t.itemRef === itemId) : undefined) ??
		kept[0] ??
		null
	);
}

async function openEbay(db: Db, o: EbayOrder): Promise<ChatOpening> {
	const { username, itemId } = await ebayOrderBuyer(o.externalId);
	if (!username)
		return { kind: "failed", reason: "eBay didn't say who the buyer is" };
	const kept = await db
		.select({
			id: buyerThreads.id,
			orderRef: buyerThreads.orderRef,
			itemRef: buyerThreads.itemRef,
		})
		.from(buyerThreads)
		.where(
			and(
				eq(buyerThreads.market, "ebay"),
				or(
					eq(buyerThreads.orderRef, o.externalId),
					sql`lower(${buyerThreads.buyerName}) = lower(${username})`,
				),
			),
		)
		.orderBy(desc(buyerThreads.id));
	const picked = pickThread(kept, o.externalId, itemId);
	if (picked) return { kind: "opened", threadId: picked.id };
	// One from before katasync read eBay's messages.
	const found = await keepEbayConversationWith(db, {
		username,
		itemId,
		orderRef: o.externalId,
	});
	if (found) return { kind: "opened", threadId: found.id };
	return { kind: "compose", to: username, last: await lastTry(db, o.id) };
}
