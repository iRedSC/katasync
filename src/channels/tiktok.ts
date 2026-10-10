import { createHmac } from "node:crypto";
import { type } from "arktype";
import { and, inArray, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders } from "#/db/schema";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { applyListingsToOrders } from "#/orders/remap";
import { matchListings, syncListings } from "./listings";
import { advanceOrderCursor, ensureStore, shippingLocation } from "./stores";

// TikTok Shop US through the Partner API (202309 versions). The app is shared
// with profit-margarine and needs these scopes in Partner Center:
// seller.authorization.info, seller.order.info, seller.product.basic,
// seller.product.write, seller.fulfillment.basic, seller.logistics,
// seller.finance.info.
// US apps still call the global host; open-api.us.tiktokglobalshop.com is a
// dead 404.
const API = "https://open-api.tiktokglobalshop.com";
// Refreshing has its own path; /token/get only trades an authorization code.
const AUTH = "https://auth.tiktok-shops.com/api/v2/token/refresh";
const STORE_NAME = "TikTok Shop";

function credentials() {
	const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN } =
		process.env;
	if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET || !TIKTOK_REFRESH_TOKEN) {
		throw new Error(
			"Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_REFRESH_TOKEN",
		);
	}
	return {
		appKey: TIKTOK_CLIENT_KEY,
		secret: TIKTOK_CLIENT_SECRET,
		refreshToken: TIKTOK_REFRESH_TOKEN,
	};
}

// Every TikTok answer wraps its data: code 0 is success.
const envelope = type({
	code: "number",
	"message?": "string",
	"data?": "unknown",
});

function unwrap(body: unknown, what: string) {
	const { code, message, data } = envelope.assert(body);
	if (code !== 0) throw new Error(`TikTok ${what}: ${message} (${code})`);
	return data;
}

const tokenData = type({
	access_token: "string",
	// Both are unix seconds, not durations.
	access_token_expire_in: "number",
	refresh_token: "string",
	refresh_token_expire_in: "number",
});

let cachedToken: { value: string; expiresAt: number } | undefined;
// Set when the refresh token is close to expiring, so every sync says so.
let refreshWarning: string | null = null;

// Trades the refresh token for an access token. TikTok hands back a new
// refresh token every time, but earlier ones keep working until they expire
// (decades out), so the stored one can be shared with profit-margarine.
async function accessToken() {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60_000) {
		return cachedToken.value;
	}
	const { appKey, secret, refreshToken } = credentials();
	const url = new URL(AUTH);
	url.search = new URLSearchParams({
		app_key: appKey,
		app_secret: secret,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	}).toString();
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`TikTok login failed: ${response.status} ${await response.text()}`,
		);
	}
	const data = tokenData.assert(unwrap(await response.json(), "login"));
	const daysLeft =
		(data.refresh_token_expire_in * 1000 - Date.now()) / 86_400_000;
	refreshWarning =
		daysLeft < 14
			? `TikTok authorization expires in ${Math.max(0, Math.floor(daysLeft))} days; authorize the app again`
			: null;
	cachedToken = {
		value: data.access_token,
		expiresAt: data.access_token_expire_in * 1000,
	};
	return cachedToken.value;
}

// TikTok's request signature: HMAC-SHA256 over the path, the sorted query
// (without sign and access_token), and the body, wrapped in the secret.
export function signRequest(
	path: string,
	query: Record<string, string>,
	body: string,
	secret: string,
) {
	const params = Object.keys(query)
		.filter((k) => k !== "sign" && k !== "access_token")
		.sort()
		.map((k) => k + query[k])
		.join("");
	return createHmac("sha256", secret)
		.update(secret + path + params + body + secret)
		.digest("hex");
}

async function tiktokApi(
	path: string,
	query: Record<string, string>,
	body?: Record<string, unknown>,
): Promise<unknown> {
	const { appKey, secret } = credentials();
	const bodyText = body ? JSON.stringify(body) : "";
	for (let attempt = 1; ; attempt++) {
		const signed: Record<string, string> = {
			...query,
			app_key: appKey,
			timestamp: String(Math.floor(Date.now() / 1000)),
		};
		signed.sign = signRequest(path, signed, bodyText, secret);
		const response = await fetch(
			`${API}${path}?${new URLSearchParams(signed)}`,
			{
				method: body ? "POST" : "GET",
				headers: {
					"Content-Type": "application/json",
					"x-tts-access-token": await accessToken(),
				},
				body: body ? bodyText : undefined,
			},
		);
		if (response.status === 429 && attempt < 6) {
			await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
			continue;
		}
		if (!response.ok) {
			throw new Error(
				`TikTok answered ${response.status} on ${path}: ${await response.text()}`,
			);
		}
		return unwrap(await response.json(), path);
	}
}

const shopsData = type({
	shops: type({ cipher: "string", name: "string", region: "string" }).array(),
});

let cachedCipher: string | undefined;

// Calls about a shop need its cipher. The app is authorized for one US shop.
async function shopCipher() {
	if (cachedCipher) return cachedCipher;
	const { shops } = shopsData.assert(
		await tiktokApi("/authorization/202309/shops", {}),
	);
	const shop = shops.find((s) => s.region === "US") ?? shops[0];
	if (!shop) throw new Error("TikTok shows no shop authorized for this app");
	cachedCipher = shop.cipher;
	return cachedCipher;
}

export const tiktokOrder = type({
	id: "string",
	// UNPAID, ON_HOLD, AWAITING_SHIPMENT, PARTIALLY_SHIPPING,
	// AWAITING_COLLECTION, IN_TRANSIT, DELIVERED, COMPLETED, CANCELLED.
	status: "string",
	// Unix seconds.
	create_time: "number",
	update_time: "number",
	"cancel_time?": "number",
	// FULFILLMENT_BY_SELLER, or FULFILLMENT_BY_TIKTOK from TikTok's warehouse.
	"fulfillment_type?": "string",
	"payment?": {
		"total_amount?": "string",
		"shipping_fee?": "string",
	},
	"recipient_address?": {
		"name?": "string",
		"phone_number?": "string",
		"address_line1?": "string",
		"address_line2?": "string",
		"postal_code?": "string",
		"region_code?": "string",
		"district_info?": type({
			address_level_name: "string",
			address_name: "string",
			// "TX" for a state, like Shopify's province code.
			"iso_code?": "string",
		}).array(),
	},
	line_items: type({
		id: "string",
		sku_id: "string",
		"seller_sku?": "string",
		product_name: "string",
		"sku_name?": "string",
		sale_price: "string",
		"display_status?": "string",
	}).array(),
});

const fulfillment: Record<string, string> = {
	// Paid, but TikTok holds it an hour in case the buyer cancels.
	ON_HOLD: "ON_HOLD",
	UNPAID: "AWAITING_PAYMENT",
	AWAITING_SHIPMENT: "UNFULFILLED",
	PARTIALLY_SHIPPING: "PARTIALLY_FULFILLED",
	// The label is bought on TikTok; the carrier just hasn't scanned it.
	AWAITING_COLLECTION: "FULFILLED",
	IN_TRANSIT: "FULFILLED",
	DELIVERED: "FULFILLED",
	COMPLETED: "FULFILLED",
	CANCELLED: "FULFILLMENT_NOT_REQUIRED",
};

// When TikTok buys the label, it hides the buyer behind asterisks ("J***n");
// a hidden value is no value.
function shown(value: string | undefined) {
	return value && !value.includes("*") ? value : null;
}

const money = (value: string | undefined) => Number(value ?? 0) || 0;
const fromUnix = (seconds: number) => new Date(seconds * 1000);

export function tiktokToChannelOrder(
	order: typeof tiktokOrder.infer,
): ChannelOrder {
	const fbt = order.fulfillment_type === "FULFILLMENT_BY_TIKTOK";
	const address = order.recipient_address;
	const district = (level: string) => {
		const found = address?.district_info?.find(
			(d) => d.address_level_name.toLowerCase() === level,
		);
		return shown(found?.iso_code || found?.address_name);
	};
	// TikTok lists every unit as its own line item; one line per SKU reads
	// like the other channels and stays stable if a unit is cancelled.
	const bySku = new Map<string, ChannelOrder["lines"][number]>();
	for (const item of order.line_items) {
		if (item.display_status === "CANCELLED") continue;
		const line = bySku.get(item.sku_id);
		if (line) {
			line.quantity++;
			continue;
		}
		bySku.set(item.sku_id, {
			externalId: item.sku_id,
			listingExternalId: item.sku_id,
			sku: item.seller_sku || null,
			title:
				item.sku_name && item.sku_name !== "Default"
					? `${item.product_name} - ${item.sku_name}`
					: item.product_name,
			quantity: 1,
			// What the buyer paid per unit, after every discount.
			unitPrice: money(item.sale_price),
		});
	}
	return {
		externalId: order.id,
		name: order.id,
		// Shopify's TikTok channel used the same name, so older relayed orders
		// and direct ones read alike.
		salesChannel: "TikTok",
		marketplaceOrderId: `tiktok:${order.id}`,
		placedAt: fromUnix(order.create_time),
		cancelledAt:
			order.status === "CANCELLED"
				? fromUnix(order.cancel_time ?? order.update_time)
				: null,
		fulfillmentStatus: fbt
			? "FULFILLMENT_NOT_REQUIRED"
			: (fulfillment[order.status] ?? "UNFULFILLED"),
		fulfilledByChannel: fbt,
		financialStatus: order.status === "UNPAID" ? "PENDING" : "PAID",
		customerName: shown(address?.name),
		shipAddress1: shown(address?.address_line1),
		shipAddress2: shown(address?.address_line2),
		shipCity: district("city"),
		shipRegion: district("state"),
		shipPostalCode: shown(address?.postal_code),
		shipCountry: address?.region_code ?? null,
		shipPhone: shown(address?.phone_number),
		total: money(order.payment?.total_amount),
		shippingCharged: money(order.payment?.shipping_fee),
		sourceUpdatedAt: fromUnix(order.update_time),
		lines: [...bySku.values()],
	};
}

const searchPage = type({
	"orders?": type({ id: "string" }).array(),
	"next_page_token?": "string",
});

const detailPage = type({ "orders?": tiktokOrder.array() });

const DAY = 24 * 60 * 60 * 1000;
const FIRST_SYNC_DAYS = 60;

export async function syncTiktok(db: Db, options: { listings: boolean }) {
	const cipher = await shopCipher();
	// Created only once TikTok answers, because its existence is what stops
	// Shopify from importing TikTok orders.
	const store = await ensureStore(db, "tiktok", STORE_NAME);
	const locationId = await shippingLocation(db);
	const problems: string[] = [];

	let mapped: number[] = [];
	if (options.listings) {
		const matched = await syncTiktokListings(db, store.id, cipher);
		mapped = matched.mapped;
		problems.push(...matched.skipped);
	}
	// Orders that sold a newly matched listing pick up the product now.
	const caughtUp = await applyListingsToOrders(db, mapped, locationId);
	problems.push(...caughtUp.problems);

	const since =
		store.ordersSyncedThrough ?? new Date(Date.now() - FIRST_SYNC_DAYS * DAY);
	const startedAt = new Date();
	let count = 0;
	let pageToken: string | undefined;
	do {
		const page = searchPage.assert(
			await tiktokApi(
				"/order/202309/orders/search",
				{
					shop_cipher: cipher,
					page_size: "50",
					sort_field: "update_time",
					sort_order: "ASC",
					...(pageToken ? { page_token: pageToken } : {}),
				},
				{
					update_time_ge: Math.floor(since.getTime() / 1000),
					update_time_lt: Math.floor(startedAt.getTime() / 1000),
				},
			),
		);
		const ids = (page.orders ?? []).map((o) => o.id);
		const owned = await ownedElsewhere(db, store.id, ids);
		const fresh = ids.filter((id) => !owned.has(id));
		if (fresh.length > 0) {
			const details = detailPage.assert(
				await tiktokApi("/order/202309/orders", {
					shop_cipher: cipher,
					ids: fresh.join(","),
				}),
			);
			for (const order of details.orders ?? []) {
				const result = await ingestOrder(
					db,
					store,
					tiktokToChannelOrder(order),
					locationId,
				);
				problems.push(...result.problems);
				count++;
			}
		}
		pageToken = page.next_page_token || undefined;
	} while (pageToken);
	// Orders changed during this pass are picked up next time.
	await advanceOrderCursor(db, store.id, startedAt);
	if (refreshWarning) problems.push(refreshWarning);
	return { store: store.name, orders: count, problems };
}

// TikTok orders already saved from another store: the ones Shopify relayed
// before katasync talked to TikTok directly. They stay with Shopify, which
// keeps updating them, rather than being saved twice.
async function ownedElsewhere(db: Db, storeId: number, ids: string[]) {
	if (ids.length === 0) return new Set<string>();
	const rows = await db
		.select({ marketplaceOrderId: orders.marketplaceOrderId })
		.from(orders)
		.where(
			and(
				inArray(
					orders.marketplaceOrderId,
					ids.map((id) => `tiktok:${id}`),
				),
				ne(orders.storeId, storeId),
			),
		);
	return new Set(
		rows.map((r) => (r.marketplaceOrderId ?? "").slice("tiktok:".length)),
	);
}

const productsPage = type({
	"products?": type({
		id: "string",
		title: "string",
		status: "string",
		skus: type({ id: "string", "seller_sku?": "string" }).array(),
	}).array(),
	"next_page_token?": "string",
});

// Records every TikTok SKU as a listing and matches them to products by SKU.
async function syncTiktokListings(db: Db, storeId: number, cipher: string) {
	let pageToken: string | undefined;
	do {
		const page = productsPage.assert(
			await tiktokApi(
				"/product/202309/products/search",
				{
					shop_cipher: cipher,
					page_size: "100",
					...(pageToken ? { page_token: pageToken } : {}),
				},
				{},
			),
		);
		await syncListings(
			db,
			storeId,
			(page.products ?? []).flatMap((p) =>
				p.skus.map((s) => ({
					externalId: s.id,
					externalSku: s.seller_sku || null,
					title: p.title,
					fulfillment: "merchant" as const,
					status: p.status,
				})),
			),
		);
		pageToken = page.next_page_token || undefined;
	} while (pageToken);
	return matchListings(db);
}
