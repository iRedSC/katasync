import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { aiConfigured } from "#/ai/harness";
import { firstEbayMessage, openChat } from "#/buyers/start-chat";
import { threadsPage } from "#/buyers/threads";
import { getDb } from "#/db/client";

// Writing to an order's buyer from its page. Only server functions here: a
// plain export would keep these imports in the browser bundle.

// The buyer's conversation for the order, opened or started; nothing is sent.
export const openBuyerChat = createServerFn({ method: "POST" })
	.validator(type({ orderId: "number.integer > 0" }))
	.handler(async ({ data }) => openChat(getDb(), data.orderId));

// The first message to an eBay buyer, which is what starts the conversation.
export const sendFirstEbayMessage = createServerFn({ method: "POST" })
	.validator(type({ orderId: "number.integer > 0", text: "string > 0" }))
	.handler(async ({ data }) =>
		firstEbayMessage(getDb(), data.orderId, data.text),
	);

// One conversation as the Inbox shows it, for the order page's chat.
export const getBuyerChat = createServerFn({ method: "GET" })
	.validator(type({ threadId: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const [thread] = await threadsPage(getDb(), { id: data.threadId }, null);
		return { thread: thread ?? null, ai: aiConfigured() };
	});
