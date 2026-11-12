import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { runBuyerMessages } from "#/buyers/run";
import {
	clearWaiting,
	countWaitingByMarket,
	MESSAGE_MARKETS,
	messageSources,
	unclearThreads,
} from "#/buyers/threads";
import { getDb } from "#/db/client";
import { readMarketMail } from "#/inbox/market-mail";

// The Inbox's Buyers folder: how many buyers wait on a reply in each
// marketplace, answered there. Only server functions here: a plain export
// would keep these imports in the browser bundle.

export const listBuyerMarkets = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [waiting, sources] = await Promise.all([
			countWaitingByMarket(db),
			messageSources(db),
		]);
		return MESSAGE_MARKETS.map((market) => {
			const source = sources.find((s) => s.market === market);
			return {
				market,
				waiting: waiting[market],
				// Whether the count can be trusted right now.
				source: !source
					? ({ kind: "behind", checkedAt: null } as const)
					: source.error
						? ({ kind: "failed", error: source.error } as const)
						: source.behind
							? ({ kind: "behind", checkedAt: source.checkedAt } as const)
							: ({ kind: "read" } as const),
			};
		});
	},
);

export type BuyerMarket = Awaited<ReturnType<typeof listBuyerMarkets>>[number];

// Clears a marketplace's count: every thread waiting there needs no answer.
export const clearBuyerMarket = createServerFn({ method: "POST" })
	.validator(type({ market: "'amazon' | 'ebay' | 'tiktok'" }))
	.handler(async ({ data }) => ({
		cleared: await clearWaiting(getDb(), data.market),
	}));

export const unclearBuyerThreads = createServerFn({ method: "POST" })
	.validator(type({ ids: "(number.integer > 0)[]" }))
	.handler(async ({ data }) => unclearThreads(getDb(), data.ids));

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
