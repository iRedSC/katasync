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
import {
	shopifyStatusSaysShipped,
	shopifyToChannelOrder,
	tiktokOrderId,
} from "./channel-order";
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
			if (result.kind === "tiktok") continue;
			problems.push(...result.problems);
			if (result.kind === "saved") count++;
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

// What became of one order. tiktok: once katasync syncs TikTok itself,
// TikTok orders come from there, and the TikTok sync takes over the ones
// Shopify relayed earlier. unread: left as last saved, with why, so the
// rest of the pass still runs.
type Ingested =
	| { kind: "tiktok" }
	| { kind: "unread"; problems: [string] }
	| { kind: "saved"; problems: string[] };

// One order as Shopify sent it.
async function ingestNode(
	db: Db,
	store: Awaited<ReturnType<typeof ensureStore>>,
	o: typeof orderNode.infer,
	stock: StockLocations,
	tiktokDirect: boolean,
): Promise<Ingested> {
	const relayedId = tiktokOrderId(o.tags);
	if (tiktokDirect && relayedId) return { kind: "tiktok" };
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
	// shipped, and an order whose status can't say what shipped needs its
	// fulfillments read, so only those orders cost the extra calls
	// (shopifyShipped).
	const refunded =
		!order.cancelledAt &&
		order.lineItems.nodes.some((l) => l.currentQuantity < l.quantity);
	const shipped =
		refunded || !shopifyStatusSaysShipped(order.displayFulfillmentStatus)
			? await shippedUnits(o.id)
			: null;
	// A refund can't be counted without every fulfillment, and a guess would
	// move stock, so the order waits as it was.
	if (refunded && !shipped)
		return {
			kind: "unread",
			problems: [
				`${order.name}: has more Shopify fulfillments than one read holds, so its refunds weren't synced. Check its stock by hand.`,
			],
		};
	const remaining = refunded && shipped ? await remainingUnits(o.id) : null;
	const channelOrder = shopifyToChannelOrder(order, shipped, remaining);
	// Checked again under the lock TikTok's takeover holds: TikTok may have
	// started syncing since tiktokDirect was read.
	const saved = relayedId
		? await ingestRelayed(
				db,
				store,
				{ ...channelOrder, marketplaceOrderId: relayedId },
				stock,
			)
		: await ingestOrder(db, store, channelOrder, stock);
	return saved
		? { kind: "saved", problems: saved.problems }
		: { kind: "tiktok" };
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
	if (result.kind === "tiktok")
		return { kind: "ignored", reason: "tiktok_source" };
	if (result.kind === "saved") await keepShopifyEmails(db, store.id, [order]);
	return orderUpdate(result.problems);
}
