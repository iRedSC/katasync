import type { Db } from "#/db/client";
import { buyerMessageChecks } from "#/db/schema";
import { recordFeed } from "#/diagnostics/feed-record";
import { threadAmazonMail } from "./amazon-mail";
import { syncEbayMessages } from "./ebay-messages";
import { syncTiktokMessages } from "./tiktok-messages";

// One run of buyer messages: Amazon's emails into threads, and eBay's and
// TikTok's conversations read, so each marketplace's waiting count is
// current. Each part records how it went on its own, so one failing never
// hides or stops another.
export async function runBuyerMessages(db: Db, { sweep = false } = {}) {
	const started = new Date();
	const amazon = await threadAmazonMail(db)
		.then((threaded) => ({ threaded, problems: [] as string[] }))
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
	await recordMessages(
		db,
		"amazon",
		started,
		"threaded" in amazon
			? { problems: amazon.problems }
			: { problems: amazon.problems, failed: amazon.problems[0] },
	);
	const ebayAt = new Date();
	const ebay = process.env.EBAY_REFRESH_TOKEN
		? await syncEbayMessages(db, { sweep })
		: { skipped: "set EBAY_REFRESH_TOKEN" };
	if ("read" in ebay) await recordMessages(db, "ebay", ebayAt, ebay);
	const tiktokAt = new Date();
	const tiktok = process.env.TIKTOK_REFRESH_TOKEN
		? await syncTiktokMessages(db, { sweep })
		: { skipped: "set TIKTOK_REFRESH_TOKEN" };
	if ("read" in tiktok) await recordMessages(db, "tiktok", tiktokAt, tiktok);
	return { amazon, ebay, tiktok };
}

// One market's read on its messages feed (src/diagnostics/feed-health.ts).
// Logged rather than thrown if it can't be written: the read itself worked.
function recordMessages(
	db: Db,
	market: "amazon" | "ebay" | "tiktok",
	startedAt: Date,
	result: { problems: string[]; failed?: string },
) {
	return recordFeed(
		db,
		market,
		"messages",
		startedAt,
		result.failed !== undefined
			? { kind: "failed", error: result.failed }
			: { kind: "read", problems: result.problems },
	).catch((e: unknown) =>
		console.error(`Couldn't record ${market} messages health:`, e),
	);
}
