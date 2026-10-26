import { type } from "arktype";
import { XMLParser } from "fast-xml-parser";
import type { Db } from "#/db/client";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { applyListingsToOrders } from "#/orders/remap";
import type { OrderTax } from "#/orders/tax";
import {
	type ChannelListing,
	markGoneListings,
	matchListings,
	syncListings,
} from "./listings";
import { advanceOrderCursor, ensureStore, stockLocations } from "./stores";

// eBay US through the Sell Fulfillment API, and its listings through the
// Trading API, which (unlike the Inventory API) sees listings made in Seller
// Hub.
export const API = "https://api.ebay.com";
// Must be scopes the user granted; eBay rejects a refresh that asks for
// more. The token is shared with profit-margarine, which was granted these
// plus sell.fulfillment.readonly. sell.fulfillment marks orders shipped;
// sell.inventory pushes stock to listings.
const SYNC_SCOPES = [
	"https://api.ebay.com/oauth/api_scope",
	"https://api.ebay.com/oauth/api_scope/sell.fulfillment",
	"https://api.ebay.com/oauth/api_scope/sell.inventory",
	"https://api.ebay.com/oauth/api_scope/sell.finances",
];
const SCOPES = SYNC_SCOPES.join(" ");

// What signing in again (pnpm ebay:authorize) asks for: sync's, what
// profit-margarine reads with, seller standards for Markets
// (src/markets/ebay-standing.ts), and buyer messages.
export const EBAY_CONSENT_SCOPES = [
	...SYNC_SCOPES,
	"https://api.ebay.com/oauth/api_scope/sell.payment.dispute",
	"https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
	"https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
	// Buyer messages (src/buyers/ebay-messages.ts).
	"https://api.ebay.com/oauth/api_scope/commerce.message",
];

let cachedToken: { value: string; expiresAt: number } | undefined;

// Trades the refresh token for a 2-hour access token. eBay's refresh token
// doesn't change when used, so sharing it is safe.
export async function accessToken(scope = SCOPES) {
	if (scope !== SCOPES) return (await refreshAccessToken(scope)).access_token;
	if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
		return cachedToken.value;
	}
	const token = await refreshAccessToken(scope);
	cachedToken = {
		value: token.access_token,
		expiresAt: Date.now() + token.expires_in * 1000,
	};
	return token.access_token;
}

async function refreshAccessToken(scope: string) {
	const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN } =
		process.env;
	if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN) {
		throw new Error(
			"Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REFRESH_TOKEN",
		);
	}
	const response = await fetch(`${API}/identity/v1/oauth2/token`, {
		method: "POST",
		signal: AbortSignal.timeout(15_000),
		headers: {
			Authorization: `Basic ${Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: EBAY_REFRESH_TOKEN,
			scope,
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
	return body;
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
		"ebayCollectAndRemitTaxes?": type({
			"taxType?": "string",
			amount: money,
		}).array(),
	}).array(),
});

export const ordersPage = type({
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

// eBay collects US sales tax and pays it itself, per line, by kind
// (STATE_SALES_TAX → "State sales tax").
export function ebayTax(
	order: Pick<typeof ebayOrder.infer, "lineItems">,
): OrderTax {
	return {
		remittedBy: "marketplace",
		lines: order.lineItems.flatMap((l) =>
			(l.ebayCollectAndRemitTaxes ?? []).map((t) => {
				const kind = (t.taxType ?? "SALES_TAX")
					.toLowerCase()
					.replaceAll("_", " ");
				return {
					jurisdiction: kind.charAt(0).toUpperCase() + kind.slice(1),
					rate: null,
					amount: t.amount.value,
				};
			}),
		),
	};
}

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
		soldInStore: false,
		financialStatus: payment[order.orderPaymentStatus ?? ""] ?? null,
		customerName: shipTo?.fullName ?? null,
		buyerId: null,
		shipCity: shipTo?.contactAddress?.city ?? null,
		shipRegion: shipTo?.contactAddress?.stateOrProvince ?? null,
		shipCountry: shipTo?.contactAddress?.countryCode ?? null,
		shipAddress1: shipTo?.contactAddress?.addressLine1 ?? null,
		shipAddress2: shipTo?.contactAddress?.addressLine2 ?? null,
		shipPostalCode: shipTo?.contactAddress?.postalCode ?? null,
		shipPhone: shipTo?.primaryPhone?.phoneNumber ?? null,
		total: order.pricingSummary.total.value,
		shippingCharged: order.pricingSummary.deliveryCost?.value ?? 0,
		tax: ebayTax(order),
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

// One page of GetMyeBaySelling's active listings, as much as we keep.
const activePage = type({
	GetMyeBaySellingResponse: {
		Ack: "string",
		"Errors?": type({ LongMessage: "string" }).array(),
		"ActiveList?": {
			"ItemArray?": {
				Item: type({
					ItemID: "string",
					Title: "string",
					"SKU?": "string",
					"Variations?": {
						Variation: type({
							"SKU?": "string",
							"VariationTitle?": "string",
						}).array(),
					},
				}).array(),
			},
			PaginationResult: { TotalNumberOfPages: "string.integer.parse" },
		},
	},
});

const xml = new XMLParser({
	isArray: (name) => ["Item", "Variation", "Errors"].includes(name),
	// SKUs like "0012" and item IDs must stay text.
	parseTagValue: false,
});

// A page of active listings as listings, keyed the way order lines name them:
// each variation by its SKU, a listing without variations by its SKU, or by
// item ID when it has none. A listing with variations only sells those.
export function ebayListingsPage(body: string): {
	listings: ChannelListing[];
	pages: number;
} {
	const response = activePage.assert(xml.parse(body)).GetMyeBaySellingResponse;
	if (response.Ack === "Failure")
		throw new Error(
			`eBay refused the listings: ${response.Errors?.map((e) => e.LongMessage).join("; ")}`,
		);
	const listings = new Map<string, ChannelListing>();
	for (const item of response.ActiveList?.ItemArray?.Item ?? []) {
		const sold = item.Variations
			? item.Variations.Variation.map((v) => ({
					sku: v.SKU?.trim() || null,
					title: v.VariationTitle ?? item.Title,
				}))
			: [{ sku: item.SKU?.trim() || null, title: item.Title }];
		for (const { sku, title } of sold) {
			const externalId = sku ?? item.ItemID;
			// Variations without SKUs all sell under the item ID.
			if (listings.has(externalId)) continue;
			listings.set(externalId, {
				externalId,
				externalSku: sku,
				title: title.trim(),
				fulfillment: "merchant",
			});
		}
	}
	return {
		listings: [...listings.values()],
		pages: response.ActiveList?.PaginationResult.TotalNumberOfPages ?? 0,
	};
}

async function activeListings(): Promise<ChannelListing[]> {
	const all: ChannelListing[] = [];
	for (let page = 1, pages = 1; page <= pages; page++) {
		const response = await fetch(`${API}/ws/api.dll`, {
			method: "POST",
			headers: {
				"X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
				"X-EBAY-API-SITEID": "0",
				"X-EBAY-API-COMPATIBILITY-LEVEL": "1349",
				"X-EBAY-API-IAF-TOKEN": await accessToken(),
				"Content-Type": "text/xml",
			},
			body: `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
	<ActiveList>
		<Include>true</Include>
		<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
	</ActiveList>
	<OutputSelector>ActiveList.ItemArray.Item.ItemID</OutputSelector>
	<OutputSelector>ActiveList.ItemArray.Item.Title</OutputSelector>
	<OutputSelector>ActiveList.ItemArray.Item.SKU</OutputSelector>
	<OutputSelector>ActiveList.ItemArray.Item.Variations</OutputSelector>
	<OutputSelector>ActiveList.PaginationResult</OutputSelector>
</GetMyeBaySellingRequest>`,
		});
		if (!response.ok)
			throw new Error(
				`eBay answered ${response.status}: ${await response.text()}`,
			);
		const result = ebayListingsPage(await response.text());
		all.push(...result.listings);
		pages = result.pages;
	}
	return all;
}

const FIRST_SYNC_DAYS = 60;
export async function syncEbay(db: Db, options: { listings: boolean }) {
	const store = await ensureStore(db, "ebay", {
		id: "ebay-us",
		name: "eBay US",
	});
	const stock = await stockLocations(db);

	// Listings first, so order lines can resolve to products.
	const problems: string[] = [];
	let listings = 0;
	let created = 0;
	if (options.listings) {
		const active = await activeListings();
		listings = active.length;
		await syncListings(db, store.id, active);
		await markGoneListings(
			db,
			store.id,
			active.map((l) => l.externalId),
		);
		const matched = await matchListings(db);
		created = matched.created;
		problems.push(...matched.skipped);
		// Orders that sold a newly matched listing pick up the product now.
		const caughtUp = await applyListingsToOrders(db, matched.mapped, stock);
		problems.push(...caughtUp.problems);
	}

	const since =
		store.ordersSyncedThrough ??
		new Date(Date.now() - FIRST_SYNC_DAYS * 24 * 60 * 60 * 1000);
	const startedAt = new Date();
	let url: string | undefined =
		`${API}/sell/fulfillment/v1/order?limit=200&filter=${encodeURIComponent(`lastmodifieddate:[${since.toISOString()}..]`)}`;
	let count = 0;

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
				stock,
			);
			problems.push(...result.problems);
			count++;
		}
		url = page.next;
	}
	// Orders changed during this pass are picked up next time.
	await advanceOrderCursor(db, store.id, startedAt);
	return { store: store.name, listings, created, orders: count, problems };
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
