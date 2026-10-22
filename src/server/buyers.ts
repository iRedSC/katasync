import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { aiConfigured } from "#/ai/harness";
import { buyerOrder } from "#/buyers/order";
import { runBuyerMessages } from "#/buyers/run";
import { reply } from "#/buyers/send";
import {
	logOurs,
	messageSources,
	setThreadDone,
	threadsPage,
	unlogOurs,
} from "#/buyers/threads";
import { getDb } from "#/db/client";
import { readMarketMail } from "#/inbox/market-mail";

// The Inbox's Buyers folder: conversations with buyers, answered in place.
// Only server functions here: a plain export would keep these imports in
// the browser bundle.

const market = "'shopify' | 'amazon' | 'ebay' | 'tiktok'";

export const listBuyerThreads = createServerFn({ method: "GET" })
	.validator(type({ view: "'open' | 'done'", market: `${market} | null` }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [threads, sources] = await Promise.all([
			threadsPage(db, data.view, data.market),
			messageSources(db),
		]);
		// The AI is a bonus: without it, no suggestions or Translate show.
		return { threads, sources, ai: aiConfigured() };
	});

export type BuyerThreadsPage = Awaited<ReturnType<typeof listBuyerThreads>>;

// Kept before it's sent; what comes back is how far it got. The browser's
// key names the reply, so sending it again after a lost answer is the same
// reply, never a second.
export const replyToBuyer = createServerFn({ method: "POST" })
	.validator(
		type({
			threadId: "number.integer > 0",
			text: "string > 0",
			requestKey: "string.uuid",
		}),
	)
	.handler(async ({ data }) =>
		reply(getDb(), data.threadId, data.text, data.requestKey),
	);

// A reply sent on the marketplace itself, added without sending, and its
// undo.
export const logBuyerReply = createServerFn({ method: "POST" })
	.validator(
		type({
			threadId: "number.integer > 0",
			text: "string > 0",
			requestKey: "string.uuid",
		}),
	)
	.handler(async ({ data }) =>
		logOurs(getDb(), data.threadId, data.text, data.requestKey),
	);

export const unlogBuyerReply = createServerFn({ method: "POST" })
	.validator(type({ requestKey: "string.uuid" }))
	.handler(async ({ data }) => unlogOurs(getDb(), data.requestKey));

// The thread's order and its packages, asked of the carriers as it opens.
export const getBuyerOrder = createServerFn({ method: "GET" })
	.validator(type({ threadId: "number.integer > 0" }))
	.handler(async ({ data }) => buyerOrder(getDb(), data.threadId));

export const setBuyerThreadDone = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", done: "boolean" }))
	.handler(async ({ data }) => setThreadDone(getDb(), data.id, data.done));

// Reads every source now, as the cron does, so staff needn't wait for it.
// Amazon's come by email, so the mailbox is read first.
export const checkBuyerMessagesNow = createServerFn({ method: "POST" }).handler(
	async () => {
		const mail = await readMarketMail({
			since: new Date(),
			sweep: true,
			db: getDb,
		});
		return { mail, ...(await runBuyerMessages(getDb())) };
	},
);
