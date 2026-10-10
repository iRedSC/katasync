import { type } from "arktype";
import type { Db } from "#/db/client";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { advanceOrderCursor, ensureStore, shippingLocation } from "./stores";

// eBay US through the Sell Fulfillment API.
export const API = "https://api.ebay.com";
// Must be scopes the user granted; eBay rejects a refresh that asks for
// more. The token is shared with profit-margarine, which was granted these
// plus sell.fulfillment.readonly. sell.fulfillment marks orders shipped;
// sell.inventory pushes stock to listings.
const SCOPES = [
	"https://api.ebay.com/oauth/api_scope",
	"https://api.ebay.com/oauth/api_scope/sell.fulfillment",
	"https://api.ebay.com/oauth/api_scope/sell.inventory",
	"https://api.ebay.com/oauth/api_scope/sell.finances",
].join(" ");

let cachedToken: { value: string; expiresAt: number } | undefined;

// Trades the refresh token for a 2-hour access token. eBay's refresh token
// doesn't change when used, so sharing it is safe.
export async function accessToken() {
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

// eBay's carrier codes for the carriers Shippo sells; anything else is sent
// as eBay's "Other".
export function ebayCarrierCode(carrier: string) {
	const known: Record<string, string> = {
		USPS: "USPS",
		UPS: "UPS",
		FEDEX: "FEDEX",
		"DHL EXPRESS": "DHL",
		DHL: "DHL",
	};
	return known[carrier.trim().toUpperCase()] ?? "Other";
}

const shippingFulfillments = type({
	"fulfillments?": type({
		fulfillmentId: "string",
		"shipmentTrackingNumber?": "string",
	}).array(),
});

// Marks these line items shipped with this tracking; eBay tells the buyer.
// Returns eBay's id for the shipping fulfillment. Safe to repeat: tracking
// already on the order returns that fulfillment instead of adding another.
// eBay has no way to take one back, so a voided label's tracking stays.
export async function ebayFulfill(
	orderId: string,
	shipment: {
		lineItems: { lineItemId: string; quantity: number }[];
		carrier: string;
		trackingNumber: string;
		shippedAt: Date;
	},
) {
	const url = `${API}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`;
	const existing = await fetch(url, {
		headers: { Authorization: `Bearer ${await accessToken()}` },
	});
	if (!existing.ok) {
		throw new Error(
			`eBay answered ${existing.status}: ${await existing.text()}`,
		);
	}
	const already = shippingFulfillments
		.assert(await existing.json())
		.fulfillments?.find(
			(f) => f.shipmentTrackingNumber === shipment.trackingNumber,
		);
	if (already) return already.fulfillmentId;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await accessToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			lineItems: shipment.lineItems,
			shippedDate: shipment.shippedAt.toISOString(),
			shippingCarrierCode: ebayCarrierCode(shipment.carrier),
			trackingNumber: shipment.trackingNumber,
		}),
	});
	if (!response.ok) {
		throw new Error(
			`eBay refused: ${response.status} ${await response.text()}`,
		);
	}
	// The new fulfillment's id is the last part of the Location header.
	return response.headers.get("location")?.split("/").pop() ?? null;
}
