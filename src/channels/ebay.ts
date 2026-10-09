import { type } from "arktype";
import type { Db } from "#/db/client";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { advanceOrderCursor, ensureStore, shippingLocation } from "./stores";

// eBay US through the Sell Fulfillment API.
const API = "https://api.ebay.com";
// Must match the scopes the user granted; eBay rejects a refresh that asks
// for more.
const SCOPES = [
	"https://api.ebay.com/oauth/api_scope",
	"https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
	"https://api.ebay.com/oauth/api_scope/sell.finances",
].join(" ");

let cachedToken: { value: string; expiresAt: number } | undefined;

// Trades the refresh token for a 2-hour access token. eBay's refresh token
// doesn't change when used, so sharing it is safe.
async function accessToken() {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
		return cachedToken.value;
	}
	const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN } =
		process.env;
	if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN) {
		throw new Error(
			"Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REFRESH_TOKEN",
		);
	}
	const response = await fetch(`${API}/identity/v1/oauth2/token`, {
		method: "POST",
		headers: {
			Authorization: `Basic ${Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: EBAY_REFRESH_TOKEN,
			scope: SCOPES,
		}),
	});
	if (!response.ok) {
		// A refresh token containing "#" gets cut off unless it's quoted in .env.
		throw new Error(
			`eBay login failed: ${response.status} ${await response.text()}`,
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

const money = type({ value: "string.numeric.parse" });

export const ebayOrder = type({
	orderId: "string",
	"legacyOrderId?": "string",
	creationDate: "string.date.iso.parse",
	lastModifiedDate: "string.date.iso.parse",
	orderFulfillmentStatus: "string",
	"orderPaymentStatus?": "string",
	"cancelStatus?": { "cancelState?": "string" },
	pricingSummary: { total: money, "deliveryCost?": money },
	"fulfillmentStartInstructions?": type({
		"shippingStep?": {
			"shipTo?": {
				"fullName?": "string",
				"contactAddress?": {
					"addressLine1?": "string",
					"addressLine2?": "string",
					"city?": "string",
					"stateOrProvince?": "string",
					"postalCode?": "string",
					"countryCode?": "string",
				},
				"primaryPhone?": { "phoneNumber?": "string" },
			},
		},
	}).array(),
	lineItems: type({
		lineItemId: "string",
		"legacyItemId?": "string",
		"sku?": "string",
		title: "string",
		quantity: "number.integer",
		lineItemCost: money,
		"appliedPromotions?": type({ "discountAmount?": money }).array(),
	}).array(),
});

const ordersPage = type({
	"orders?": ebayOrder.array(),
	"next?": "string",
});

const fulfillment: Record<string, string> = {
	NOT_STARTED: "UNFULFILLED",
	IN_PROGRESS: "PARTIALLY_FULFILLED",
	FULFILLED: "FULFILLED",
};

const payment: Record<string, string> = {
	PAID: "PAID",
	PENDING: "PENDING",
	FAILED: "VOIDED",
	FULLY_REFUNDED: "REFUNDED",
	PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
};

export function ebayToChannelOrder(
	order: typeof ebayOrder.infer,
): ChannelOrder {
	const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
	return {
		externalId: order.orderId,
		name: order.legacyOrderId ?? order.orderId,
		salesChannel: "eBay",
		marketplaceOrderId: `ebay:${order.orderId}`,
		placedAt: order.creationDate,
		cancelledAt:
			order.cancelStatus?.cancelState === "CANCELED"
				? order.lastModifiedDate
				: null,
		fulfillmentStatus:
			fulfillment[order.orderFulfillmentStatus] ?? "UNFULFILLED",
		fulfilledByChannel: false,
		financialStatus: payment[order.orderPaymentStatus ?? ""] ?? null,
		customerName: shipTo?.fullName ?? null,
		shipCity: shipTo?.contactAddress?.city ?? null,
		shipRegion: shipTo?.contactAddress?.stateOrProvince ?? null,
		shipCountry: shipTo?.contactAddress?.countryCode ?? null,
		shipAddress1: shipTo?.contactAddress?.addressLine1 ?? null,
		shipAddress2: shipTo?.contactAddress?.addressLine2 ?? null,
		shipPostalCode: shipTo?.contactAddress?.postalCode ?? null,
		shipPhone: shipTo?.primaryPhone?.phoneNumber ?? null,
		total: order.pricingSummary.total.value,
		shippingCharged: order.pricingSummary.deliveryCost?.value ?? 0,
		sourceUpdatedAt: order.lastModifiedDate,
		lines: order.lineItems.map((l) => {
			const discount = (l.appliedPromotions ?? []).reduce(
				(sum, p) => sum + (p.discountAmount?.value ?? 0),
				0,
			);
			return {
				externalId: l.lineItemId,
				// eBay listings are keyed by SKU, or by item ID when a listing has none.
				listingExternalId: l.sku ?? l.legacyItemId ?? null,
				sku: l.sku ?? null,
				title: l.title,
				quantity: l.quantity,
				// lineItemCost covers every unit; promotions come off separately.
				unitPrice: (l.lineItemCost.value - discount) / l.quantity,
			};
		}),
	};
}

const FIRST_SYNC_DAYS = 60;

export async function syncEbay(db: Db) {
	const store = await ensureStore(db, "ebay", "eBay US");
	const locationId = await shippingLocation(db);
	const since =
		store.ordersSyncedThrough ??
		new Date(Date.now() - FIRST_SYNC_DAYS * 24 * 60 * 60 * 1000);
	const startedAt = new Date();
	let url: string | undefined =
		`${API}/sell/fulfillment/v1/order?limit=200&filter=${encodeURIComponent(`lastmodifieddate:[${since.toISOString()}..]`)}`;
	let count = 0;
	const problems: string[] = [];

	while (url) {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${await accessToken()}` },
		});
		if (!response.ok) {
			throw new Error(
				`eBay answered ${response.status}: ${await response.text()}`,
			);
		}
		const page = ordersPage.assert(await response.json());
		for (const order of page.orders ?? []) {
			const result = await ingestOrder(
				db,
				store,
				ebayToChannelOrder(order),
				locationId,
			);
			problems.push(...result.problems);
			count++;
		}
		url = page.next;
	}
	// Orders changed during this pass are picked up next time.
	await advanceOrderCursor(db, store.id, startedAt);
	return { store: store.name, orders: count, problems };
}
