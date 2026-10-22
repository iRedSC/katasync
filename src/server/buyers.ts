import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { runBuyerMessages } from "#/buyers/run";
import { reply } from "#/buyers/send";
import { messageSources, setThreadDone, threadsPage } from "#/buyers/threads";
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
		return { threads, sources };
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
