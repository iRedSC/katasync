import { createHmac } from "node:crypto";
import { type } from "arktype";
import { and, eq, getTableColumns, like, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orderLines, orders } from "#/db/schema";
import {
	type ChannelOrder,
	ingestOrder,
	resolveProduct,
} from "#/orders/ingest";
import { applyListingsToOrders } from "#/orders/remap";
import { importReturns } from "#/orders/return-requests";
import { stockEffectApplied } from "#/orders/stock-effects";
import { needsShipping } from "#/orders/to-ship";
import { markGoneListings, matchListings, syncListings } from "./listings";
import { type OrderUpdate, orderUpdate } from "./order-update";
import {
	advanceOrderCursor,
	ensureStore,
	type StockLocations,
	stockLocations,
} from "./stores";
import { tiktokOrder, tiktokToChannelOrder } from "./tiktok/channel-order";
import { fetchTiktokReturns } from "./tiktok-returns";

export {
	tiktokOrder,
	tiktokTax,
	tiktokToChannelOrder,
} from "./tiktok/channel-order";

// TikTok Shop US through the Partner API (202309 versions). The app is shared
// with profit-margarine and needs TIKTOK_SCOPES in Partner Center; the shop
// grants them when it authorizes the app (pnpm tiktok:authorize).
// US apps still call the global host; open-api.us.tiktokglobalshop.com is a
// dead 404.
const API = "https://open-api.tiktokglobalshop.com";

export const TIKTOK_SCOPES = [
	"seller.authorization.info",
	"seller.order.info",
	"seller.product.basic",
	"seller.product.write",
	"seller.fulfillment.basic",
	"seller.logistics",
	"seller.finance.info",
	// Returns, with reasons (tiktok-returns.ts).
	"seller.return_refund.basic",
] as const;
// Refreshing has its own path; /token/get only trades an authorization code.
const AUTH = "https://auth.tiktok-shops.com/api/v2/token/refresh";
const STORE = { id: "tiktok-shop", name: "TikTok Shop" };

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

// A refusal from TikTok, with its code so callers can tell refusals apart
// without reading the message.
export class TiktokError extends Error {
	constructor(
		readonly code: number,
		what: string,
		message: string | undefined,
	) {
		super(`TikTok ${what}: ${message} (${code})`);
	}
}

function unwrap(body: unknown, what: string) {
	const { code, message, data } = envelope.assert(body);
	if (code !== 0) throw new TiktokError(code, what, message);
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

// TikTok's "Internal error. Retry later" and its kin: overload that passes
// if asked again shortly. It clusters at the top of the hour, when every
// app's cron calls at once.
const RETRY_LATER = new Set([36009003]);
// Waits before the second and third tries, each jittered by half either way:
// at most 6 seconds, well inside a function's time limit.
const TRANSIENT_WAITS_MS = [1000, 3000];

// Whether a call can go out again after TikTok failed on its side, when the
// first try may still have gone through: reads, and inventory updates, which
// set a quantity rather than add one. Buying a label or shipping a package is
// never sent twice.
export function safeToRepeat(method: string, path: string) {
	return (
		method === "GET" ||
		/\/(search|query)$/.test(path) ||
		path.endsWith("/inventory/update")
	);
}

function transient(status: number, text: string) {
	if (status >= 500) return true;
	try {
		return RETRY_LATER.has(envelope.assert(JSON.parse(text)).code);
	} catch {
		return false;
	}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function tiktokApi(
	path: string,
	query: Record<string, string>,
	body?: Record<string, unknown>,
	method = body ? "POST" : "GET",
): Promise<unknown> {
	const { appKey, secret } = credentials();
	const bodyText = body ? JSON.stringify(body) : "";
	const repeatable = safeToRepeat(method, path);
	let throttled = 0;
	let failed = 0;
	for (;;) {
		const signed: Record<string, string> = {
			...query,
			app_key: appKey,
			timestamp: String(Math.floor(Date.now() / 1000)),
		};
		signed.sign = signRequest(path, signed, bodyText, secret);
		const response = await fetch(
			`${API}${path}?${new URLSearchParams(signed)}`,
			{
				method,
				headers: {
					"Content-Type": "application/json",
					"x-tts-access-token": await accessToken(),
				},
				body: body ? bodyText : undefined,
			},
		);
		// A 429 was refused before doing anything, so any call can wait it out.
		if (response.status === 429 && ++throttled < 6) {
			await wait(2000 * throttled);
			continue;
		}
		const text = await response.text();
		if (
			repeatable &&
			failed < TRANSIENT_WAITS_MS.length &&
			transient(response.status, text)
		) {
			await wait(TRANSIENT_WAITS_MS[failed++] * (0.5 + Math.random()));
			continue;
		}
		if (!response.ok) {
			throw new Error(`TikTok answered ${response.status} on ${path}: ${text}`);
		}
		return unwrap(JSON.parse(text), path);
	}
}

const shopsData = type({
	shops: type({ cipher: "string", name: "string", region: "string" }).array(),
});

let cachedCipher: string | undefined;

// Calls about a shop need its cipher. The app is authorized for one US shop.
export async function shopCipher() {
	if (cachedCipher) return cachedCipher;
	const { shops } = shopsData.assert(
		await tiktokApi("/authorization/202309/shops", {}),
	);
	const shop = shops.find((s) => s.region === "US") ?? shops[0];
	if (!shop) throw new Error("TikTok shows no shop authorized for this app");
	cachedCipher = shop.cipher;
	return cachedCipher;
}

export const searchPage = type({
	"orders?": type({ id: "string" }).array(),
	"next_page_token?": "string",
});

export const detailPage = type({ "orders?": tiktokOrder.array() });

const DAY = 24 * 60 * 60 * 1000;
const FIRST_SYNC_DAYS = 60;
const MISSING_HOLD_DAYS = 3;

export async function syncTiktok(db: Db, options: { listings: boolean }) {
	const cipher = await shopCipher();
	// Created only once TikTok answers, because its existence is what stops
	// Shopify from importing TikTok orders.
	const store = await ensureStore(db, "tiktok", STORE);
	const stock = await stockLocations(db);
	const problems: string[] = [];

	let mapped: number[] = [];
	let created = 0;
	if (options.listings) {
		const matched = await syncTiktokListings(db, store.id, cipher);
		mapped = matched.mapped;
		created = matched.created;
		problems.push(...matched.skipped);
	}
	// Orders that sold a newly matched listing pick up the product now.
	const caughtUp = await applyListingsToOrders(db, mapped, stock);
	problems.push(...caughtUp.problems);

	const since =
		store.ordersSyncedThrough ?? new Date(Date.now() - FIRST_SYNC_DAYS * DAY);
	const startedAt = new Date();
	// Orders changed since the last pass, plus relayed orders still open, so
	// those move over even if TikTok hasn't touched them lately.
	const ids = new Set(await openRelayed(db, store.id));
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
		for (const o of page.orders ?? []) ids.add(o.id);
		pageToken = page.next_page_token || undefined;
	} while (pageToken);

	let count = 0;
	const all = [...ids];
	// Asked for, but not in TikTok's answer.
	const missing: string[] = [];
	// TikTok returns at most 50 orders per detail call.
	for (let i = 0; i < all.length; i += 50) {
		const asked = all.slice(i, i + 50);
		const details = detailPage.assert(
			await tiktokApi("/order/202309/orders", {
				shop_cipher: cipher,
				ids: asked.join(","),
			}),
		);
		const answered = new Set<string>();
		for (const raw of details.orders ?? []) {
			answered.add(raw.id);
			const result = await ingestDetail(db, store, raw, stock);
			problems.push(...result.problems);
			if (result.ingested) count++;
		}
		missing.push(...asked.filter((id) => !answered.has(id)));
	}
	// Orders changed during this pass are picked up next time. With an order
	// asked for but missing from the answer, the cursor stops MISSING_HOLD_DAYS
	// short, so the next passes ask again; one TikTok never returns is given
	// up on after that, rather than pinning the cursor and growing every pass.
	if (missing.length > 0)
		problems.push(
			`TikTok didn't return ${missing.join(", ")}; syncs over the next ${MISSING_HOLD_DAYS} days ask again`,
		);
	await advanceOrderCursor(
		db,
		store.id,
		missing.length > 0
			? new Date(startedAt.getTime() - MISSING_HOLD_DAYS * DAY)
			: startedAt,
	);
	if (refreshWarning) problems.push(refreshWarning);
	// Returns after orders, so a return on a new order finds it. Every
	// listings pass rereads the last week's changes.
	if (options.listings)
		problems.push(
			...(await importReturns(db, store, () =>
				fetchTiktokReturns(
					new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
					new Date(),
				),
			)),
		);
	return { store: store.name, created, orders: count, problems };
}

export async function ingestDetail(
	db: Db,
	store: Awaited<ReturnType<typeof ensureStore>>,
	raw: typeof tiktokOrder.infer,
	stock: StockLocations,
) {
	const order = tiktokToChannelOrder(raw);
	const taken = await takeOver(db, store.id, order);
	// Still on Shopify: ingesting it here would take its stock twice.
	if (!taken.moved) return { ingested: false, problems: taken.problems };
	const result = await ingestOrder(db, store, order, stock);
	return { ingested: true, problems: [...taken.problems, ...result.problems] };
}

// One order by id, for a webhook. It doesn't move the sync cursor; the next
// pass sees the order again and reports any problems with it on Diagnostics.
export async function ingestTiktokOrder(
	db: Db,
	orderId: string,
): Promise<OrderUpdate> {
	const cipher = await shopCipher();
	const store = await ensureStore(db, "tiktok", STORE);
	const details = detailPage.assert(
		await tiktokApi("/order/202309/orders", {
			shop_cipher: cipher,
			ids: orderId,
		}),
	);
	const raw = details.orders?.find((order) => order.id === orderId);
	if (!raw) return { kind: "retry", error: `TikTok didn't return ${orderId}` };
	const result = await ingestDetail(db, store, raw, await stockLocations(db));
	if (!result.ingested && result.problems.length === 0)
		return { kind: "retry", error: `TikTok order ${orderId} wasn't applied` };
	return orderUpdate(result.problems);
}

// TikTok orders Shopify relayed that still need shipping.
async function openRelayed(db: Db, storeId: number) {
	const rows = await db
		.select({ marketplaceOrderId: orders.marketplaceOrderId })
		.from(orders)
		.where(
			and(
				ne(orders.storeId, storeId),
				like(orders.marketplaceOrderId, "tiktok:%"),
				needsShipping,
			),
		);
	return rows.map((r) => (r.marketplaceOrderId ?? "").slice("tiktok:".length));
}

// Moves an order Shopify relayed over to the TikTok store, so TikTok's own
// status (a label bought, a cancellation) decides it from now on. Its lines
// are re-keyed to TikTok's by SKU, or by product (resolved the way ingestion
// does: listing, exact SKU, alias) when the SKUs differ, so stock they already
// took isn't taken again. Pin and stock history stay. If a line that took
// stock can't be matched, the order stays with Shopify: moving it would let
// ingestion take that stock a second time.
export async function takeOver(
	db: Db,
	storeId: number,
	order: ChannelOrder,
): Promise<{ moved: boolean; problems: string[] }> {
	return db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ id: orders.id, name: orders.name })
			.from(orders)
			.where(
				and(
					eq(orders.marketplaceOrderId, order.marketplaceOrderId ?? ""),
					ne(orders.storeId, storeId),
				),
			);
		if (!existing) return { moved: true, problems: [] };

		const productOf = new Map<string, number | null>();
		for (const l of order.lines) {
			productOf.set(l.externalId, await resolveProduct(tx, storeId, l));
		}
		const sameSku = (a: string | null, b: string | null) =>
			a !== null &&
			b !== null &&
			a.trim().toLowerCase() === b.trim().toLowerCase();

		const problems: string[] = [];
		let blocked = false;
		const claimed = new Set<string>();
		const matches: { lineId: number; to: ChannelOrder["lines"][number] }[] = [];
		const lines = await tx
			.select({
				...getTableColumns(orderLines),
				stockApplied: sql<boolean>`coalesce(${stockEffectApplied}, false)`,
			})
			.from(orderLines)
			.where(eq(orderLines.orderId, existing.id));
		for (const line of lines) {
			const open = order.lines.filter((l) => !claimed.has(l.externalId));
			const match =
				open.find((l) => sameSku(l.sku, line.sku)) ??
				open.find(
					(l) =>
						line.productId !== null &&
						productOf.get(l.externalId) === line.productId,
				);
			if (!match) {
				problems.push(
					`${existing.name}: ${line.title} isn't on the TikTok order`,
				);
				if (line.stockApplied) blocked = true;
				continue;
			}
			claimed.add(match.externalId);
			matches.push({ lineId: line.id, to: match });
		}
		if (blocked) {
			problems.push(`${existing.name}: left on Shopify until its lines match`);
			return { moved: false, problems };
		}

		await tx
			.update(orders)
			.set({ storeId, externalId: order.externalId })
			.where(eq(orders.id, existing.id));
		for (const { lineId, to } of matches) {
			await tx
				.update(orderLines)
				.set({
					externalId: to.externalId,
					listingExternalId: to.listingExternalId,
				})
				.where(eq(orderLines.id, lineId));
		}
		return { moved: true, problems };
	});
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
	const reported: string[] = [];
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
		const listed = (page.products ?? []).flatMap((p) =>
			p.skus.map((s) => ({
				externalId: s.id,
				externalSku: s.seller_sku || null,
				title: p.title,
				fulfillment: "merchant" as const,
				status: p.status,
			})),
		);
		await syncListings(db, storeId, listed);
		reported.push(...listed.map((l) => l.externalId));
		pageToken = page.next_page_token || undefined;
	} while (pageToken);
	await markGoneListings(db, storeId, reported);
	return matchListings(db);
}
