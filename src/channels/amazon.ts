import { type } from "arktype";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders } from "#/db/schema";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { applyListingsToOrders } from "#/orders/remap";
import { importReturns } from "#/orders/return-requests";
import type { OrderTax } from "#/orders/tax";
import { MARKETPLACE_US, spApi } from "./amazon-api";
import {
	amazonListings,
	fbaQuantities,
	mirrorFbaStock,
} from "./amazon-listings";
import { recentAmazonReturns } from "./amazon-returns";
import { markGoneListings, matchListings, syncListings } from "./listings";
import { advanceOrderCursor, ensureStore, stockLocations } from "./stores";

// Amazon US orders through the Selling Partner API (Orders v0).

const money = type({ Amount: "string.numeric.parse" });

export const amazonOrder = type({
	AmazonOrderId: "string",
	PurchaseDate: "string.date.iso.parse",
	LastUpdateDate: "string.date.iso.parse",
	OrderStatus: "string",
	FulfillmentChannel: "'MFN' | 'AFN'",
	"OrderTotal?": money,
	"ShippingAddress?": {
		"City?": "string",
		"StateOrRegion?": "string",
		"CountryCode?": "string",
	},
});

export const amazonItem = type({
	OrderItemId: "string",
	"SellerSKU?": "string",
	Title: "string",
	QuantityOrdered: "number.integer",
	"ItemPrice?": money,
	"PromotionDiscount?": money,
	"ShippingPrice?": money,
	"ShippingDiscount?": money,
	"ItemTax?": money,
	"ShippingTax?": money,
	"PromotionDiscountTax?": money,
	"ShippingDiscountTax?": money,
});

export const ordersPage = type({
	payload: {
		Orders: amazonOrder.array(),
		"NextToken?": "string",
	},
});

const itemsPage = type({
	payload: { OrderItems: amazonItem.array(), "NextToken?": "string" },
});

const fulfillment: Record<string, string> = {
	// Payment hasn't cleared; Amazon says not to ship yet.
	Pending: "AWAITING_PAYMENT",
	Unshipped: "UNFULFILLED",
	PartiallyShipped: "PARTIALLY_FULFILLED",
	Shipped: "FULFILLED",
	InvoiceUnconfirmed: "FULFILLED",
	Unfulfillable: "ON_HOLD",
	Canceled: "FULFILLMENT_NOT_REQUIRED",
};

const amount = (m: { Amount: number } | undefined) => m?.Amount ?? 0;

// Amazon collects US sales tax and pays it itself. Each item's tax comes
// with the tax on its discounts, which comes off.
export function amazonTax(items: (typeof amazonItem.infer)[]): OrderTax {
	return {
		remittedBy: "marketplace",
		lines: items.flatMap((i) => [
			{
				jurisdiction: "Sales tax on items",
				rate: null,
				amount: amount(i.ItemTax) - amount(i.PromotionDiscountTax),
			},
			{
				jurisdiction: "Sales tax on shipping",
				rate: null,
				amount: amount(i.ShippingTax) - amount(i.ShippingDiscountTax),
			},
		]),
	};
}

export function amazonToChannelOrder(
	order: typeof amazonOrder.infer,
	items: (typeof amazonItem.infer)[],
): ChannelOrder {
	const fba = order.FulfillmentChannel === "AFN";
	return {
		externalId: order.AmazonOrderId,
		name: order.AmazonOrderId,
		salesChannel: fba ? "Amazon FBA" : "Amazon",
		marketplaceOrderId: `amazon:${order.AmazonOrderId}`,
		placedAt: order.PurchaseDate,
		// Amazon doesn't say when an order was cancelled; its last update is
		// the closest honest answer.
		cancelledAt: order.OrderStatus === "Canceled" ? order.LastUpdateDate : null,
		// Pending is Amazon not yet confirming the sale, FBA or not: it has
		// no price yet and nothing has shipped.
		fulfillmentStatus:
			order.OrderStatus === "Pending"
				? "AWAITING_PAYMENT"
				: fba
					? "FULFILLMENT_NOT_REQUIRED"
					: (fulfillment[order.OrderStatus] ?? "UNFULFILLED"),
		fulfilledByChannel: fba,
		soldInStore: false,
		// Pending means Amazon hasn't confirmed payment yet.
		financialStatus: order.OrderStatus === "Pending" ? "PENDING" : "PAID",
		// Buyer names need Amazon's restricted-data token; city and state don't.
		customerName: null,
		buyerId: null,
		shipCity: order.ShippingAddress?.City ?? null,
		shipRegion: order.ShippingAddress?.StateOrRegion ?? null,
		shipCountry: order.ShippingAddress?.CountryCode ?? null,
		// Street, ZIP, and phone need the restricted Direct-to-Consumer
		// Shipping role.
		shipAddress1: null,
		shipAddress2: null,
		shipPostalCode: null,
		shipPhone: null,
		total: amount(order.OrderTotal),
		shippingCharged: items.reduce(
			(sum, i) => sum + amount(i.ShippingPrice) - amount(i.ShippingDiscount),
			0,
		),
		tax: amazonTax(items),
		sourceUpdatedAt: order.LastUpdateDate,
		// A cancelled item stays at 0 rather than being dropped, so ingestion
		// gives back the stock it took.
		lines: items.map((i) => ({
			externalId: i.OrderItemId,
			listingExternalId: i.SellerSKU ?? null,
			sku: i.SellerSKU ?? null,
			title: i.Title,
			quantity: i.QuantityOrdered,
			// ItemPrice covers every unit; promotions come off separately.
			unitPrice:
				i.QuantityOrdered > 0
					? (amount(i.ItemPrice) - amount(i.PromotionDiscount)) /
						i.QuantityOrdered
					: 0,
		})),
	};
}

const DAY = 24 * 60 * 60 * 1000;
const FIRST_SYNC_DAYS = 60;
// History is fetched in windows; the cursor moves only after a window is
// complete, so a stopped backfill resumes where it left off.
const WINDOW_MS = 3 * DAY;
// While history is still filling in, each pass also fetches recent changes
// first, so today's orders never wait behind the backfill.
const RECENT_MS = 2 * DAY;
// Amazon's rate limits make history slow; a few windows per pass keeps each
// pass short enough that recent orders stay current.
const HISTORY_WINDOWS_PER_PASS = 2;

export type AmazonWindow = {
	from: number;
	until: number;
	advancesCursor: boolean;
};

// Which time ranges one pass fetches, in order: recent changes first (only
// while the cursor lags), then the next history windows.
export function planAmazonWindows(
	cursor: number,
	latest: number,
): AmazonWindow[] {
	const windows: AmazonWindow[] = [];
	if (latest - cursor > RECENT_MS) {
		windows.push({
			from: latest - RECENT_MS,
			until: latest,
			advancesCursor: false,
		});
	}
	let from = cursor;
	for (let i = 0; i < HISTORY_WINDOWS_PER_PASS && from < latest; i++) {
		const until = Math.min(from + WINDOW_MS, latest);
		windows.push({ from, until, advancesCursor: true });
		from = until;
	}
	return windows;
}

// The listed orders already saved at their current revision, by id. Those
// need no item calls or ingest again.
export async function unchangedOrderIds(
	db: Db,
	storeId: number,
	listed: (typeof amazonOrder.infer)[],
) {
	const unchanged = new Set<string>();
	if (listed.length === 0) return unchanged;
	const saved = await db
		.select({
			externalId: orders.externalId,
			sourceUpdatedAt: orders.sourceUpdatedAt,
		})
		.from(orders)
		.where(
			and(
				eq(orders.storeId, storeId),
				inArray(
					orders.externalId,
					listed.map((o) => o.AmazonOrderId),
				),
			),
		);
	const savedAt = new Map(saved.map((s) => [s.externalId, s.sourceUpdatedAt]));
	for (const order of listed) {
		const at = savedAt.get(order.AmazonOrderId);
		if (at && at >= order.LastUpdateDate) unchanged.add(order.AmazonOrderId);
	}
	return unchanged;
}

export async function syncAmazon(db: Db, options: { listings: boolean }) {
	const store = await ensureStore(db, "amazon", {
		id: "amazon-us",
		name: "Amazon US",
	});
	const stock = await stockLocations(db);
	const problems: string[] = [];

	// Listings first, so order lines can resolve to products; then FBA stock,
	// which goes by the FBA listings' products.
	let listings = 0;
	let created = 0;
	if (options.listings) {
		const listed = await amazonListings();
		if (listed) {
			listings = listed.length;
			const { unmapped } = await syncListings(db, store.id, listed);
			await markGoneListings(
				db,
				store.id,
				listed.map((l) => l.externalId),
			);
			if (unmapped.length > 0)
				problems.push(
					`${unmapped.length} FBA listings were unmatched from tool sets; Amazon needs real units`,
				);
			const matched = await matchListings(db);
			created = matched.created;
			problems.push(...matched.skipped);
			// Orders that sold a newly matched listing pick up the product now.
			const caughtUp = await applyListingsToOrders(db, matched.mapped, stock);
			problems.push(...caughtUp.problems);
		}
		const fba = await mirrorFbaStock(db, store.id, await fbaQuantities());
		problems.push(...fba.problems);
	}

	// Amazon refuses ranges that end less than two minutes ago.
	const latest = Date.now() - 3 * 60 * 1000;
	const cursor =
		store.ordersSyncedThrough?.getTime() ?? Date.now() - FIRST_SYNC_DAYS * DAY;
	let count = 0;

	for (const window of planAmazonWindows(cursor, latest)) {
		let nextToken: string | undefined;
		do {
			const query = nextToken
				? `NextToken=${encodeURIComponent(nextToken)}`
				: `LastUpdatedAfter=${new Date(window.from).toISOString()}&LastUpdatedBefore=${new Date(window.until).toISOString()}&MaxResultsPerPage=100`;
			const page = ordersPage.assert(
				await spApi(
					`/orders/v0/orders?MarketplaceIds=${MARKETPLACE_US}&${query}`,
				),
			);
			// An order saved since its last change needs no item calls.
			const unchanged = await unchangedOrderIds(
				db,
				store.id,
				page.payload.Orders,
			);
			for (const order of page.payload.Orders) {
				if (unchanged.has(order.AmazonOrderId)) continue;
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
		if (window.advancesCursor) {
			await advanceOrderCursor(db, store.id, new Date(window.until));
		}
	}
	// Returns after orders, so a return on a new order finds it.
	if (options.listings)
		problems.push(...(await importReturns(db, store, recentAmazonReturns)));
	return { store: store.name, listings, created, orders: count, problems };
}

export async function orderItems(orderId: string) {
	const items: (typeof amazonItem.infer)[] = [];
	let nextToken: string | undefined;
	do {
		const page = itemsPage.assert(
			await spApi(
				`/orders/v0/orders/${orderId}/orderItems${nextToken ? `?NextToken=${encodeURIComponent(nextToken)}` : ""}`,
			),
		);
		items.push(...page.payload.OrderItems);
		nextToken = page.payload.NextToken;
	} while (nextToken);
	return items;
}
