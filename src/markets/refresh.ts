import { type } from "arktype";
import { eq, sql } from "drizzle-orm";
import { MARKETPLACE_US } from "#/channels/amazon-api";
import {
	listReports,
	reportText,
	requestReport,
} from "#/channels/amazon-reports";
import { shopifyQuery } from "#/channels/shopify";
import type { Db } from "#/db/client";
import { marketStanding } from "#/db/schema";
import { channelEnv, missingEnv } from "#/diagnostics/checks";
import { errorText } from "#/diagnostics/runs";
import { amazonListingIssues } from "./amazon-issues";
import { ebayStanding } from "./ebay-standing";
import { type Market, STALE_MS } from "./market";
import {
	amazonStanding,
	type Problem,
	type ShopifyDispute,
	type Standing,
	shopifyStanding,
	standing,
	withProblems,
} from "./standing";
import { tiktokStanding } from "./tiktok-standing";

// Reads each marketplace's standing and keeps it in market_standing. Run by
// the standing cron, and by Markets when what it holds has gone stale.

const AMAZON_REPORT = "GET_V2_SELLER_PERFORMANCE_REPORT";
// Amazon recomputes the report daily, so a newer one is asked for only
// after this long. It's usually ready in seconds.
const AMAZON_FRESH_MS = 12 * 60 * 60 * 1000;
const AMAZON_WAIT_MS = 30 * 1000;
const LISTINGS_UNREADABLE = "Couldn't read Amazon's listing issues";

// Amazon's account verdict. A new report takes Amazon a while to build, so
// until one is ready the last accepted verdict stands, warnings and all.
async function amazonVerdict(previous: Standing | null): Promise<Standing> {
	const reports = await listReports(AMAZON_REPORT, 5);
	let done = reports.find((r) => r.processingStatus === "DONE");
	const newest = reports[0];
	if (!newest || Date.now() - newest.createdTime.getTime() > AMAZON_FRESH_MS) {
		const fresh = await requestReport(AMAZON_REPORT, {}, AMAZON_WAIT_MS);
		if (fresh.processingStatus === "DONE") done = fresh;
	}
	const text = done ? await reportText(done) : null;
	if (text) return amazonStanding(JSON.parse(text), MARKETPLACE_US);
	if (previous?.verdict.state === "read") return accountOf(previous);
	return standing({ state: "waiting" }, [], []);
}

// What Amazon said about the account in a standing: its verdict, its metrics,
// and the problems that aren't listings (those are read again every check).
function accountOf(s: Standing): Standing {
	return standing(
		s.verdict,
		s.metrics,
		s.problems.filter(
			(p) => p.items.length === 0 && p.text !== LISTINGS_UNREADABLE,
		),
	);
}

// The account's health, then the listings Amazon blocked. Failing to read
// the listings doesn't lose the account's health; it says so instead.
async function amazon(previous: Standing | null): Promise<Standing> {
	const [account, issues] = await Promise.all([
		amazonVerdict(previous),
		amazonListingIssues().catch((error): Problem[] => [
			{
				level: "watch",
				text: LISTINGS_UNREADABLE,
				href: null,
				detail: errorText(error),
				items: [],
			},
		]),
	]);
	return withProblems(account, issues);
}

const disputedOrders = type({
	orders: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: type({
			name: "string",
			legacyResourceId: "string",
			createdAt: "string",
			totalPriceSet: {
				shopMoney: { amount: "string", currencyCode: "string" },
			},
			disputes: type({ status: "string", initiatedAs: "string" }).array(),
		}).array(),
	},
});

type DisputedOrder = (typeof disputedOrders.infer)["orders"]["nodes"][number];

// Orders read per page, and pages per search: more are only counted as far
// as that, and said so.
const SHOPIFY_PAGE = 50;
export const SHOPIFY_DISPUTE_PAGES = 20;

// Every order the search finds, newest change first, a page at a time;
// `more` when there were more than SHOPIFY_DISPUTE_PAGES pages of them.
async function shopifyOrders(search: string) {
	const orders: DisputedOrder[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < SHOPIFY_DISPUTE_PAGES; page++) {
		const page: typeof disputedOrders.infer = disputedOrders.assert(
			await shopifyQuery(
				`query ($search: String!, $cursor: String) {
					orders(first: ${SHOPIFY_PAGE}, after: $cursor, query: $search, sortKey: UPDATED_AT, reverse: true) {
						pageInfo { hasNextPage endCursor }
						nodes {
							name legacyResourceId createdAt
							totalPriceSet { shopMoney { amount currencyCode } }
							disputes { status initiatedAs }
						}
					}
				}`,
				{ search, cursor },
			),
		);
		const { pageInfo, nodes } = page.orders;
		orders.push(...nodes);
		if (!pageInfo.hasNextPage) return { orders, more: false };
		// More, but no way to ask for them: counted as cut short.
		cursor = pageInfo.endCursor ?? null;
		if (cursor === null) break;
	}
	return { orders, more: true };
}

async function shopify(): Promise<Standing> {
	const since = new Date(Date.now() - 90 * 86_400_000)
		.toISOString()
		.slice(0, 10);
	const [{ orders: open, more: moreOpen }, { orders: lost, more: moreLost }] =
		await Promise.all([
			shopifyOrders(
				"chargeback_status:needs_response OR chargeback_status:under_review",
			),
			shopifyOrders(`chargeback_status:lost updated_at:>=${since}`),
		]);
	const domain = process.env.SHOPIFY_STORE_DOMAIN;
	const disputes: ShopifyDispute[] = open.flatMap((o) =>
		o.disputes
			.filter((d) => ["NEEDS_RESPONSE", "UNDER_REVIEW"].includes(d.status))
			.map((d) => ({
				orderName: o.name,
				href: `https://${domain}/admin/orders/${o.legacyResourceId}`,
				status: d.status,
				initiatedAs: d.initiatedAs,
				total: `$${o.totalPriceSet.shopMoney.amount}`,
				placedAt: o.createdAt,
			})),
	);
	// Past the last page read, the counts are only a floor; said so.
	const cut: Problem[] = [
		...(moreOpen ? ["open disputes"] : []),
		...(moreLost ? ["chargebacks lost in 90 days"] : []),
	].map((what) => ({
		level: "watch",
		text: `Over ${SHOPIFY_DISPUTE_PAGES * SHOPIFY_PAGE} ${what}; only those were read`,
		href: null,
		detail: "The real number is higher than shown.",
		items: [],
	}));
	return withProblems(shopifyStanding(disputes, lost.length), cut);
}

// Each is given the standing saved last; Amazon keeps its verdict from it.
const fetchers: Record<
	Market,
	(previous: Standing | null) => Promise<Standing>
> = {
	amazon,
	ebay: ebayStanding,
	shopify,
	tiktok: tiktokStanding,
};

// Markets whose credentials are set, so a check can reach them.
export const checkable = (Object.keys(fetchers) as Market[]).filter(
	(m) => missingEnv(channelEnv[m]).length === 0,
);

export async function checkStanding(db: Db, market: Market) {
	const now = new Date();
	try {
		const [last] = await db
			.select({ standing: marketStanding.standing })
			.from(marketStanding)
			.where(eq(marketStanding.market, market));
		const standing = await fetchers[market](last?.standing ?? null);
		await db
			.insert(marketStanding)
			.values({ market, standing, checkedAt: now, error: null })
			.onConflictDoUpdate({
				target: marketStanding.market,
				set: { standing, checkedAt: now, error: null, erroredAt: null },
			});
	} catch (error) {
		const message = errorText(error);
		// Keeps the last answer; only says this check failed.
		await db
			.insert(marketStanding)
			.values({ market, error: message, erroredAt: now })
			.onConflictDoUpdate({
				target: marketStanding.market,
				set: { error: message, erroredAt: now },
			});
	}
}

export async function readStanding(db: Db) {
	return db.select().from(marketStanding);
}

// When it was last tried, successfully or not, so a failing market isn't
// retried on every page view.
const lastTried = (r: typeof marketStanding.$inferSelect) =>
	Math.max(r.checkedAt?.getTime() ?? 0, r.erroredAt?.getTime() ?? 0);

// Checks every reachable market not tried within maxAgeMs, side by side.
export async function checkStale(db: Db, maxAgeMs = STALE_MS) {
	const rows = await readStanding(db);
	const due = checkable.filter((m) => {
		const row = rows.find((r) => r.market === m);
		return !row || Date.now() - lastTried(row) >= maxAgeMs;
	});
	await Promise.all(due.map((m) => checkStanding(db, m)));
	return due;
}

// Markets at risk by their last answer, for the sidebar.
export async function countAtRisk(db: Db) {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(marketStanding)
		.where(sql`${marketStanding.standing}->>'level' = 'at_risk'`);
	return row?.n ?? 0;
}
