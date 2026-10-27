import { type } from "arktype";
import { type OrderUpdate, orderUpdate } from "#/channels/order-update";
import {
	ensureStore,
	type StockLocations,
	stockLocations,
} from "#/channels/stores";
import { hasTiktokStore, ingestRelayed } from "#/channels/tiktok/relay";
import type { Db } from "#/db/client";
import { ingestOrder } from "#/orders/ingest";
import { shopifyToChannelOrder, tiktokOrderId } from "./channel-order";
import { shopifyQuery } from "./client";
import { remainingUnits, shippedUnits } from "./fulfillment-units";
import { remainingLines } from "./line-items";
import { keepShopifyEmails } from "./order-emails";
import {
	ORDER_FIELDS,
	ORDERS_QUERY,
	orderNode,
	ordersPage,
} from "./order-shapes";

// Ingests every order matching a Shopify search, page by page.
export async function ingestMatching(
	db: Db,
	store: Awaited<ReturnType<typeof ensureStore>>,
	search: string,
	stock: StockLocations,
) {
	let newest: Date | null = null;
	let count = 0;
	const problems: string[] = [];
	let cursor: string | null = null;
	const tiktokDirect = await hasTiktokStore(db);
	do {
		const page = ordersPage.assert(
			await shopifyQuery(ORDERS_QUERY, { cursor, query: search }),
		);
		for (const o of page.orders.nodes) {
			if (!newest || o.updatedAt > newest) newest = o.updatedAt;
			const result = await ingestNode(db, store, o, stock, tiktokDirect);
			if (!result) continue;
			problems.push(...result.problems);
			count++;
		}
		// Once the orders are saved. Shopify not saying leaves them without;
		// Diagnostics says why.
		await keepShopifyEmails(db, store.id, page.orders.nodes);
		cursor = page.orders.pageInfo.hasNextPage
			? (page.orders.pageInfo.endCursor ?? null)
			: null;
	} while (cursor);
	return { count, newest, problems };
}

// One order as Shopify sent it. Null when it's a TikTok order: once
// katasync syncs TikTok itself, TikTok orders come from there, and the TikTok
// sync takes over the ones Shopify relayed earlier.
async function ingestNode(
	db: Db,
	store: Awaited<ReturnType<typeof ensureStore>>,
	o: typeof orderNode.infer,
	stock: StockLocations,
	tiktokDirect: boolean,
) {
	const relayedId = tiktokOrderId(o.tags);
	if (tiktokDirect && relayedId) return null;
	// Big orders have more lines than fit in one page; fetch the rest.
	const order = o.lineItems.pageInfo.hasNextPage
		? {
				...o,
				lineItems: {
					...o.lineItems,
					nodes: [
						...o.lineItems.nodes,
						...(await remainingLines(o.id, o.lineItems.pageInfo.endCursor)),
					],
				},
			}
		: o;
	// Units refunded or removed only matter once we know whether they
	// shipped, so only those orders cost the extra call.
	const shipped =
		!order.cancelledAt &&
		order.lineItems.nodes.some((l) => l.currentQuantity < l.quantity)
			? await shippedUnits(o.id)
			: null;
	const remaining = shipped ? await remainingUnits(o.id) : null;
	const channelOrder = shopifyToChannelOrder(order, shipped, remaining);
	// Checked again under the lock TikTok's takeover holds: TikTok may have
	// started syncing since tiktokDirect was read.
	return relayedId
		? ingestRelayed(
				db,
				store,
				{ ...channelOrder, marketplaceOrderId: relayedId },
				stock,
			)
		: ingestOrder(db, store, channelOrder, stock);
}

// One order by id, for a webhook. Read straight from the order rather than
// through search, which lags a few seconds behind new orders. It doesn't
// move the sync cursor; the next pass sees the order again and reports any
// problems with it on Diagnostics.
export async function ingestShopifyOrder(
	db: Db,
	orderId: string,
): Promise<OrderUpdate> {
	const { shop, order } = type({
		shop: { id: "string", name: "string" },
		order: orderNode.or("null"),
	}).assert(
		await shopifyQuery(
			`query Order($id: ID!) { shop { id name } order(id: $id) { ${ORDER_FIELDS} } }`,
			{ id: orderId },
		),
	);
	if (!order)
		return { kind: "retry", error: `Shopify didn't return ${orderId}` };
	const store = await ensureStore(db, "shopify", shop);
	const result = await ingestNode(
		db,
		store,
		order,
		await stockLocations(db),
		await hasTiktokStore(db),
	);
	if (result) await keepShopifyEmails(db, store.id, [order]);
	return result
		? orderUpdate(result.problems)
		: { kind: "ignored", reason: "tiktok_source" };
}
