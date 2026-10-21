import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders, stores } from "#/db/schema";
import { ingestOrder } from "#/orders/ingest";
import {
	ordersPage as amazonPage,
	amazonToChannelOrder,
	orderItems,
} from "./amazon";
import { MARKETPLACE_US, spApi } from "./amazon-api";
import {
	accessToken,
	API as EBAY_API,
	ordersPage as ebayPage,
	ebayToChannelOrder,
} from "./ebay";
import { backfillShopify } from "./shopify";
import { type StockLocations, stockLocations } from "./stores";
import {
	detailPage,
	ingestDetail,
	searchPage,
	shopCipher,
	tiktokApi,
} from "./tiktok";

// One-time import of older orders, for `pnpm sync --orders-history`. Regular
// passes only reach back 60 days from when each store was connected. Orders
// are taken by date placed, so old orders that never change still come in.
// It never moves a sync cursor, and orders from before a store's stockFrom
// are history only, so it can't touch stock.

const DAY = 24 * 60 * 60 * 1000;
// Each window is logged as it finishes, so a long run shows its progress.
const WINDOW_DAYS = 30;
// The regular sync already covers the newest 60 days.
const RECENT_DAYS = 60;

export const orderChannels = ["shopify", "amazon", "ebay", "tiktok"] as const;
export type OrderChannel = (typeof orderChannels)[number];

type Window = {
	db: Db;
	store: typeof stores.$inferSelect;
	stock: StockLocations;
	from: Date;
	until: Date;
};
type Ingested = { orders: number; problems: string[] };

const ingesters: Record<OrderChannel, (w: Window) => Promise<Ingested>> = {
	// Finds its own store, as its CLI flag once did.
	shopify: ({ db, from, until }) => backfillShopify(db, from, until),
	amazon: amazonWindow,
	ebay: ebayWindow,
	tiktok: tiktokWindow,
};

// Newest first, so a stopped run has the orders that matter most.
export async function backfillOrders(
	db: Db,
	channel: OrderChannel,
	days: number,
	log: (line: string) => void,
) {
	const [store] = await db
		.select()
		.from(stores)
		.where(eq(stores.channel, channel))
		.limit(1);
	if (!store) return log(`${channel}: no store synced yet`);
	const stock = await stockLocations(db);
	const oldest = Date.now() - days * DAY;
	let total = 0;
	for (
		let until = Date.now() - RECENT_DAYS * DAY;
		until > oldest;
		until -= WINDOW_DAYS * DAY
	) {
		const from = new Date(Math.max(oldest, until - WINDOW_DAYS * DAY));
		const result = await ingesters[channel]({
			db,
			store,
			stock,
			from,
			until: new Date(until),
		});
		for (const problem of result.problems) log(`  ${problem}`);
		total += result.orders;
		log(
			`${channel} from ${from.toISOString().slice(0, 10)}: ${result.orders} orders`,
		);
	}
	log(`${channel}: ${total} older orders`);
}

// Amazon allows about one order list a minute and two item calls a second,
// so a year takes hours. Orders already saved and unchanged since skip their
// item calls, so a stopped run picks up quickly where it left off.
async function amazonWindow({ db, store, stock, from, until }: Window) {
	const problems: string[] = [];
	let count = 0;
	let nextToken: string | undefined;
	do {
		const query = nextToken
			? `NextToken=${encodeURIComponent(nextToken)}`
			: `CreatedAfter=${from.toISOString()}&CreatedBefore=${until.toISOString()}&MaxResultsPerPage=100`;
		const page = amazonPage.assert(
			await spApi(
				`/orders/v0/orders?MarketplaceIds=${MARKETPLACE_US}&${query}`,
			),
		);
		const listed = page.payload.Orders;
		const saved =
			listed.length === 0
				? []
				: await db
						.select({
							externalId: orders.externalId,
							sourceUpdatedAt: orders.sourceUpdatedAt,
						})
						.from(orders)
						.where(
							and(
								eq(orders.storeId, store.id),
								inArray(
									orders.externalId,
									listed.map((o) => o.AmazonOrderId),
								),
							),
						);
		const savedAt = new Map(
			saved.map((s) => [s.externalId, s.sourceUpdatedAt]),
		);
		for (const order of listed) {
			const at = savedAt.get(order.AmazonOrderId);
			if (at && at >= order.LastUpdateDate) continue;
			const items = await orderItems(order.AmazonOrderId);
			const result = await ingestOrder(
				db,
				store,
				amazonToChannelOrder(order, items),
				stock,
			);
			problems.push(...result.problems);
			count++;
		}
		nextToken = page.payload.NextToken;
	} while (nextToken);
	return { orders: count, problems };
}

async function ebayWindow({ db, store, stock, from, until }: Window) {
	const problems: string[] = [];
	let count = 0;
	let url: string | undefined =
		`${EBAY_API}/sell/fulfillment/v1/order?limit=200&filter=${encodeURIComponent(`creationdate:[${from.toISOString()}..${until.toISOString()}]`)}`;
	while (url) {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${await accessToken()}` },
		});
		if (!response.ok)
			throw new Error(
				`eBay answered ${response.status}: ${await response.text()}`,
			);
		const page = ebayPage.assert(await response.json());
		for (const order of page.orders ?? []) {
			const result = await ingestOrder(
				db,
				store,
				ebayToChannelOrder(order),
				stock,
			);
			problems.push(...result.problems);
			count++;
		}
		url = page.next;
	}
	return { orders: count, problems };
}

// Through the same takeover as regular passes, so an order Shopify relayed
// moves to TikTok rather than being saved twice.
async function tiktokWindow({ db, store, stock, from, until }: Window) {
	const cipher = await shopCipher();
	const ids: string[] = [];
	let pageToken: string | undefined;
	do {
		const page = searchPage.assert(
			await tiktokApi(
				"/order/202309/orders/search",
				{
					shop_cipher: cipher,
					page_size: "50",
					sort_field: "create_time",
					sort_order: "ASC",
					...(pageToken ? { page_token: pageToken } : {}),
				},
				{
					create_time_ge: Math.floor(from.getTime() / 1000),
					create_time_lt: Math.floor(until.getTime() / 1000),
				},
			),
		);
		for (const o of page.orders ?? []) ids.push(o.id);
		pageToken = page.next_page_token || undefined;
	} while (pageToken);

	const problems: string[] = [];
	let count = 0;
	// TikTok returns at most 50 orders per detail call.
	for (let i = 0; i < ids.length; i += 50) {
		const details = detailPage.assert(
			await tiktokApi("/order/202309/orders", {
				shop_cipher: cipher,
				ids: ids.slice(i, i + 50).join(","),
			}),
		);
		for (const raw of details.orders ?? []) {
			const result = await ingestDetail(db, store, raw, stock);
			problems.push(...result.problems);
			if (result.ingested) count++;
		}
	}
	return { orders: count, problems };
}
