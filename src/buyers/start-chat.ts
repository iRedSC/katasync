import { and, desc, eq, sql } from "drizzle-orm";
import { detailPage, shopCipher, tiktokApi } from "#/channels/tiktok";
import type { Db } from "#/db/client";
import { buyerThreads, orders, stores } from "#/db/schema";
import { refuseWords } from "./attachments";
import { buyerMarket, type ChatOpening, type FirstMessage } from "./chat-way";
import {
	ebayOrderBuyer,
	keepEbayConversationWith,
	sendEbayMessage,
} from "./ebay-messages";
import { Refused } from "./states";
import { ensureThread } from "./threads";
import {
	openTiktokConversation,
	readStartedTiktokThread,
} from "./tiktok-messages";

// Writing to an order's buyer from its page when they haven't written first
// (chat-way.ts says when it's offered). Opening a conversation sends
// nothing: on TikTok it's opened and kept as an empty thread, answered
// through the usual reply path (send.ts); on eBay a conversation only
// exists once a message is in it, so the first message starts it here.
// Server only.

const why = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

async function orderOf(db: Db, orderId: number) {
	const [o] = await db
		.select({
			id: orders.id,
			channel: stores.channel,
			externalId: orders.externalId,
			marketplaceOrderId: orders.marketplaceOrderId,
			buyerId: orders.buyerId,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(eq(orders.id, orderId));
	if (!o) throw new Error(`No order ${orderId}`);
	return o;
}

type Order = Awaited<ReturnType<typeof orderOf>>;

// The order's ID on TikTok, its own or the one Shopify relayed.
const tiktokId = (o: Order) =>
	o.channel === "tiktok"
		? o.externalId
		: (o.marketplaceOrderId?.slice("tiktok:".length) ?? null);

// A failure to open a TikTok conversation: TikTok's plain no (outside its
// limits on the order), or anything else, which may pass if tried again.
export function tiktokStartFailure(error: unknown): ChatOpening {
	return error instanceof Refused
		? { kind: "refused", reason: error.message }
		: { kind: "failed", reason: why(error) };
}

// A first eBay message that didn't come back with an ID. Only a plain no
// means it didn't go; anything else may have.
export function firstMessageFailure(error: unknown): FirstMessage {
	return error instanceof Refused
		? { kind: "refused", reason: error.message }
		: {
				kind: "unsure",
				reason: `eBay didn't say whether it went (${why(error)}). Check eBay Messages before sending again`,
			};
}

export async function openChat(db: Db, orderId: number): Promise<ChatOpening> {
	const o = await orderOf(db, orderId);
	const market = buyerMarket(o);
	try {
		if (market === "tiktok") return await openTiktok(db, o);
		if (market === "ebay") return await openEbay(db, o);
	} catch (error) {
		return { kind: "failed", reason: why(error) };
	}
	return {
		kind: "refused",
		reason: `katasync can't start ${market} conversations`,
	};
}

async function openTiktok(db: Db, o: Order): Promise<ChatOpening> {
	const ref = tiktokId(o);
	if (!ref) return { kind: "failed", reason: "No TikTok order ID" };
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
	// TikTok keeps one conversation per buyer: it's about the order it was
	// last opened from.
	const thread = await ensureThread(db, {
		market: "tiktok",
		externalId: conversationId,
		subject: "TikTok Shop chat",
		orderRef: ref,
	});
	if (thread.orderRef !== ref)
		await db
			.update(buyerThreads)
			.set({ orderRef: ref })
			.where(eq(buyerThreads.id, thread.id));
	// What TikTok already put in it; the thread works without it.
	await readStartedTiktokThread(db, thread.id).catch(() => {});
	return { kind: "started", threadId: thread.id };
}

// An eBay buyer's conversation katasync keeps, by their username.
async function keptWith(db: Db, username: string) {
	const [t] = await db
		.select({ id: buyerThreads.id, orderRef: buyerThreads.orderRef })
		.from(buyerThreads)
		.where(
			and(
				eq(buyerThreads.market, "ebay"),
				sql`lower(${buyerThreads.buyerName}) = lower(${username})`,
			),
		)
		.orderBy(desc(buyerThreads.id))
		.limit(1);
	return t ?? null;
}

async function openEbay(db: Db, o: Order): Promise<ChatOpening> {
	const { username, itemId } = await ebayOrderBuyer(o.externalId);
	if (!username)
		return { kind: "failed", reason: "eBay didn't say who the buyer is" };
	const kept = await keptWith(db, username);
	if (kept) {
		// Now the order page lists it too.
		if (kept.orderRef === null)
			await db
				.update(buyerThreads)
				.set({ orderRef: o.externalId })
				.where(eq(buyerThreads.id, kept.id));
		return { kind: "opened", threadId: kept.id };
	}
	// One from before katasync read eBay's messages.
	const found = await keepEbayConversationWith(db, {
		username,
		itemId,
		orderRef: o.externalId,
	});
	return found
		? { kind: "opened", threadId: found.id }
		: { kind: "compose", to: username };
}

// The first message to an eBay buyer, which starts the conversation. Sent
// once per call and never again on its own: eBay has no request key.
export async function firstEbayMessage(
	db: Db,
	orderId: number,
	text: string,
): Promise<FirstMessage> {
	const body = text.trim();
	if (!body) return { kind: "refused", reason: "Write something first" };
	const tooLong = refuseWords("ebay", body);
	if (tooLong) return { kind: "refused", reason: tooLong };
	let to: Awaited<ReturnType<typeof ebayOrderBuyer>>;
	let o: Order;
	try {
		o = await orderOf(db, orderId);
		to = await ebayOrderBuyer(o.externalId);
	} catch (error) {
		// Nothing was sent yet.
		return { kind: "refused", reason: why(error) };
	}
	const username = to.username;
	if (!username)
		return { kind: "refused", reason: "eBay didn't say who the buyer is" };
	let messageId: string;
	try {
		messageId = await sendEbayMessage({ username, itemId: to.itemId }, body);
	} catch (error) {
		return firstMessageFailure(error);
	}
	try {
		const thread = await keepEbayConversationWith(
			db,
			{ username, itemId: to.itemId, orderRef: o.externalId },
			messageId,
		);
		return thread
			? { kind: "sent", threadId: thread.id }
			: { kind: "sent_unlisted" };
	} catch {
		// It went; only finding its conversation failed.
		return { kind: "sent_unlisted" };
	}
}
