import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { aiConfigured } from "#/ai/harness";
import { chatOrder } from "#/buyers/chat-order";
import { marketRef } from "#/buyers/chat-way";
import { firstEbayMessage } from "#/buyers/first-message";
import { openChat } from "#/buyers/start-chat";
import { threadsPage } from "#/buyers/threads";
import { getDb } from "#/db/client";

// Writing to an order's buyer from its page. Only server functions here: a
// plain export would keep these imports in the browser bundle.

// The buyer's conversation for the order, opened or started; nothing is sent.
export const openBuyerChat = createServerFn({ method: "POST" })
	.validator(type({ orderId: "number.integer > 0" }))
	.handler(async ({ data }) => openChat(getDb(), data.orderId));

// The first message to an eBay buyer, which is what starts the conversation.
// The browser's key names the try: the same key again never sends twice.
export const sendFirstEbayMessage = createServerFn({ method: "POST" })
	.validator(
		type({
			orderId: "number.integer > 0",
			text: "string > 0",
			requestKey: "string.uuid",
		}),
	)
	.handler(async ({ data }) =>
		firstEbayMessage(getDb(), data.orderId, data.text, data.requestKey),
	);

// One conversation as the Inbox shows it, for the order page's chat, with
// the order it's opened from, which its suggested reply must be about
// (suggestion.tsx).
export const getBuyerChat = createServerFn({ method: "GET" })
	.validator(
		type({ threadId: "number.integer > 0", orderId: "number.integer > 0" }),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [[thread], order] = await Promise.all([
			threadsPage(db, { id: data.threadId }, null),
			chatOrder(db, data.orderId),
		]);
		return {
			thread: thread ?? null,
			ai: aiConfigured(),
			order: { id: order.id, ref: marketRef(order) },
		};
	});
