import type { Db } from "#/db/client";
import { buyerMessageChecks } from "#/db/schema";
import { threadAmazonMail } from "./amazon-mail";
import { syncEbayMessages } from "./ebay-messages";
import { settleReplies } from "./send";

// One run of buyer messages: Amazon's emails into threads, eBay's
// conversations read, and every reply in flight settled. Each part records
// how it went on its own, so one failing never hides or stops another.
export async function runBuyerMessages(db: Db, { sweep = false } = {}) {
	const amazon = await threadAmazonMail(db)
		.then(async (threaded) => ({ threaded, ...(await settleReplies(db)) }))
		.catch((e: unknown) => ({
			problems: [e instanceof Error ? e.message : String(e)],
		}));
	const now = new Date();
	const set =
		amazon.problems.length === 0
			? { checkedAt: now, error: null, erroredAt: null }
			: { error: amazon.problems.join("; ").slice(0, 2000), erroredAt: now };
	await db
		.insert(buyerMessageChecks)
		.values({ market: "amazon", ...set })
		.onConflictDoUpdate({ target: buyerMessageChecks.market, set });
	const ebay = process.env.EBAY_REFRESH_TOKEN
		? await syncEbayMessages(db, { sweep })
		: { skipped: "set EBAY_REFRESH_TOKEN" };
	return { amazon, ebay };
}
