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
import {
	remainingUnits,
	type ShippedUnits,
	shippedUnits,
} from "./fulfillment-units";
import { remainingLines } from "./line-items";
import { keepShopifyEmails } from "./order-emails";
import {
	ORDER_FIELDS,
	ORDERS_QUERY,
	orderNode,
	ordersPage,
} from "./order-shapes";

// Ingests every order matching a Shopify search, page by page. retryFrom is
// the earliest change time of an order whose fulfillments failed to read (an
// error, which may pass, not too many to read, which won't): the sync cursor
// stops there so the next pass reads it again.
export async function ingestMatching(
	db: Db,
	store: Awaited<ReturnType<typeof ensureStore>>,
	search: string,
	stock: StockLocations,
) {
	let newest: Date | null = null;
	let retryFrom: Date | null = null;
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
			if (result.readFailed && (!retryFrom || o.updatedAt < retryFrom))
				retryFrom = o.updatedAt;
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
	return { count, newest, retryFrom, problems };
}

// What became of one order. tiktok: once katasync syncs TikTok itself,
// TikTok orders come from there, and the TikTok sync takes over the ones
// Shopify relayed earlier. unread: left as last saved, with why, so the
// rest of the pass still runs. readFailed: Shopify erred reading its
// fulfillments, so it's worth reading again.
type Ingested =
	| { kind: "tiktok" }
	| { kind: "unread"; problems: [string]; readFailed: boolean }
	| { kind: "saved"; problems: string[]; readFailed: boolean };

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
	const read =
		refunded || !shopifyStatusSaysShipped(order.displayFulfillmentStatus)
			? await readFulfillments(o.id, refunded)
			: null;
	const problems: string[] = [];
	const readFailed = read?.kind === "failed";
	if (read && read.kind !== "read") {
		// A refund can't be counted without every fulfillment, and a guess
		// would move stock, so the order waits as it was.
		if (refunded)
			return {
				kind: "unread",
				readFailed,
				problems: [
					`${order.name}: ${unreadWhy(read)}, so its refunds weren't synced. Check its stock by hand.`,
				],
			};
		// Anything else saves with what shipped unknown, which keeps it from
		// being packed; the problem says why.
		problems.push(
			`${order.name}: ${unreadWhy(read)}, so what's left to ship is unknown. Ship it from Shopify.`,
		);
	}
	const shipped = read?.kind === "read" ? read.shipped : null;
	const remaining = read?.kind === "read" ? read.remaining : null;
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
		? { kind: "saved", readFailed, problems: [...problems, ...saved.problems] }
		: { kind: "tiktok" };
}

// An order's fulfillments, and for a refunded one what's left of each line.
// Shopify failing to answer is about this order alone, so it comes back as
// a result rather than stopping the pass.
type Fulfillments =
	| {
			kind: "read";
			shipped: ShippedUnits;
			remaining: Map<string, number> | null;
	  }
	| { kind: "truncated" }
	| { kind: "failed"; error: string };

async function readFulfillments(
	orderId: string,
	refunded: boolean,
): Promise<Fulfillments> {
	try {
		const shipped = await shippedUnits(orderId);
		if (!shipped) return { kind: "truncated" };
		const remaining = refunded ? await remainingUnits(orderId) : null;
		return { kind: "read", shipped, remaining };
	} catch (err) {
		return {
			kind: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

const unreadWhy = (read: Exclude<Fulfillments, { kind: "read" }>) =>
	read.kind === "truncated"
		? "has more Shopify fulfillments than one read holds"
		: `Shopify's fulfillments couldn't be read (${read.error})`;

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
