import { type } from "arktype";
import type { Db } from "#/db/client";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { advanceOrderCursor, ensureStore, shippingLocation } from "./stores";

// Amazon US through the Selling Partner API (Orders v0).
const ENDPOINT = "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_US = "ATVPDKIKX0DER";

let cachedToken: { value: string; expiresAt: number } | undefined;

// Trades the long-lived refresh token for a 1-hour access token. Amazon's
// refresh token doesn't change when used, so sharing it is safe.
export async function accessToken() {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
		return cachedToken.value;
	}
	const { AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, AMAZON_REFRESH_TOKEN } =
		process.env;
	if (!AMAZON_CLIENT_ID || !AMAZON_CLIENT_SECRET || !AMAZON_REFRESH_TOKEN) {
		throw new Error(
			"Set AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, and AMAZON_REFRESH_TOKEN",
		);
	}
	const response = await fetch("https://api.amazon.com/auth/o2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: AMAZON_REFRESH_TOKEN,
			client_id: AMAZON_CLIENT_ID,
			client_secret: AMAZON_CLIENT_SECRET,
		}),
	});
	if (!response.ok) {
		throw new Error(
			`Amazon login failed: ${response.status} ${await response.text()}`,
		);
	}
	const body = type({ access_token: "string", expires_in: "number" }).assert(
		await response.json(),
	);
	cachedToken = {
		value: body.access_token,
		expiresAt: Date.now() + body.expires_in * 1000,
	};
	return cachedToken.value;
}

// GETs an SP-API path, waiting and retrying when Amazon says to slow down.
// Order lists allow about one call a minute once the burst is spent.
export async function spApi(path: string): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(`${ENDPOINT}${path}`, {
			headers: { "x-amz-access-token": await accessToken() },
		});
		if (response.status === 429 && attempt < 8) {
			const rate = Number(response.headers.get("x-amzn-ratelimit-limit"));
			const wait = rate > 0 ? Math.max(2000, 1000 / rate) : 2000 * attempt;
			await new Promise((resolve) => setTimeout(resolve, wait));
			continue;
		}
		if (!response.ok) {
			throw new Error(
				`Amazon answered ${response.status}: ${await response.text()}`,
			);
		}
		return response.json();
	}
}

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
});

const ordersPage = type({
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
		fulfillmentStatus: fba
			? "FULFILLMENT_NOT_REQUIRED"
			: (fulfillment[order.OrderStatus] ?? "UNFULFILLED"),
		fulfilledByChannel: fba,
		// Pending means Amazon hasn't confirmed payment yet.
		financialStatus: order.OrderStatus === "Pending" ? "PENDING" : "PAID",
		// Buyer names need Amazon's restricted-data token; city and state don't.
		customerName: null,
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

export async function syncAmazon(db: Db) {
	const store = await ensureStore(db, "amazon", "Amazon US");
	const locationId = await shippingLocation(db);
	// Amazon refuses ranges that end less than two minutes ago.
	const latest = Date.now() - 3 * 60 * 1000;
	const cursor =
		store.ordersSyncedThrough?.getTime() ?? Date.now() - FIRST_SYNC_DAYS * DAY;
	let count = 0;
	const problems: string[] = [];

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
			for (const order of page.payload.Orders) {
				const items = await orderItems(order.AmazonOrderId);
				const result = await ingestOrder(
					db,
					store,
					amazonToChannelOrder(order, items),
					locationId,
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
	return { store: store.name, orders: count, problems };
}

async function orderItems(orderId: string) {
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
