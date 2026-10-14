import { type } from "arktype";
import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, stores } from "#/db/schema";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { applyListingsToOrders } from "#/orders/remap";
import { cleanTitle, matchListings, syncListings } from "./listings";
import { advanceOrderCursor, ensureStore, shippingLocation } from "./stores";

const API_VERSION = "2026-10";

function credentials() {
	const domain = process.env.SHOPIFY_STORE_DOMAIN;
	const token = process.env.SHOPIFY_ADMIN_TOKEN;
	if (!domain || !token) {
		throw new Error("Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN");
	}
	return { domain, token };
}

const graphqlResponse = type({
	"data?": "unknown",
	"errors?": type({
		message: "string",
		"extensions?": { "code?": "string" },
	}).array(),
});

// Calls the Admin GraphQL API, waiting and retrying when Shopify throttles.
// With timeoutMs, gives up once that long has passed, throttle waits
// included.
export async function shopifyQuery(
	query: string,
	variables: Record<string, unknown>,
	{ timeoutMs }: { timeoutMs?: number } = {},
) {
	const { domain, token } = credentials();
	const deadline = timeoutMs
		? Date.now() + timeoutMs
		: Number.POSITIVE_INFINITY;
	for (let attempt = 1; ; attempt++) {
		let body: typeof graphqlResponse.infer;
		try {
			const response = await fetch(
				`https://${domain}/admin/api/${API_VERSION}/graphql.json`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Shopify-Access-Token": token,
					},
					body: JSON.stringify({ query, variables }),
					signal: timeoutMs
						? AbortSignal.timeout(Math.max(1, deadline - Date.now()))
						: undefined,
				},
			);
			if (!response.ok) {
				throw new Error(
					`Shopify answered ${response.status}: ${await response.text()}`,
				);
			}
			body = graphqlResponse.assert(await response.json());
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") {
				throw new Error(`Shopify didn't answer within ${timeoutMs}ms`);
			}
			throw err;
		}
		const throttled = body.errors?.some(
			(e) => e.extensions?.code === "THROTTLED",
		);
		const wait = 2000 * attempt;
		if (throttled && attempt < 6 && Date.now() + wait < deadline) {
			await new Promise((resolve) => setTimeout(resolve, wait));
			continue;
		}
		if (body.errors?.length) {
			throw new Error(
				`Shopify error: ${body.errors.map((e) => e.message).join("; ")}`,
			);
		}
		return body.data;
	}
}

const money = type({ shopMoney: { amount: "string.numeric.parse" } });

const orderNode = type({
	id: "string",
	name: "string",
	sourceName: "string | null",
	tags: "string[]",
	app: type({ name: "string" }).or("null"),
	channelInformation: type({
		channelDefinition: type({ channelName: "string" }).or("null"),
	}).or("null"),
	createdAt: "string.date.iso.parse",
	updatedAt: "string.date.iso.parse",
	cancelledAt: "string.date.iso.parse | null",
	displayFulfillmentStatus: "string",
	displayFinancialStatus: "string | null",
	totalPriceSet: money,
	totalShippingPriceSet: money,
	shippingAddress: type({
		name: "string | null",
		address1: "string | null",
		address2: "string | null",
		city: "string | null",
		provinceCode: "string | null",
		zip: "string | null",
		countryCodeV2: "string | null",
		phone: "string | null",
	}).or("null"),
	lineItems: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: type({
			id: "string",
			sku: "string | null",
			name: "string",
			quantity: "number.integer",
			variant: type({ id: "string" }).or("null"),
			discountedUnitPriceAfterAllDiscountsSet: money,
		}).array(),
	},
});

const ordersPage = type({
	orders: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: orderNode.array(),
	},
});

const ORDER_FIELDS = `
	id name createdAt updatedAt cancelledAt sourceName tags
	app { name }
	channelInformation { channelDefinition { channelName } }
	displayFulfillmentStatus displayFinancialStatus
	totalPriceSet { shopMoney { amount } }
	totalShippingPriceSet { shopMoney { amount } }
	shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 phone }
	lineItems(first: 30) {
		pageInfo { hasNextPage endCursor }
		nodes {
			id sku name quantity
			variant { id }
			discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
		}
	}`;

const ORDERS_QUERY = `
query Orders($cursor: String, $query: String) {
	orders(first: 25, after: $cursor, sortKey: UPDATED_AT, query: $query) {
		pageInfo { hasNextPage endCursor }
		nodes { ${ORDER_FIELDS} }
	}
}`;

const lineItem = type({
	id: "string",
	sku: "string | null",
	name: "string",
	quantity: "number.integer",
	variant: type({ id: "string" }).or("null"),
	discountedUnitPriceAfterAllDiscountsSet: money,
});

const linesPage = type({
	order: {
		lineItems: {
			pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
			nodes: lineItem.array(),
		},
	},
});

const LINES_QUERY = `
query Lines($id: ID!, $cursor: String) {
	order(id: $id) {
		lineItems(first: 100, after: $cursor) {
			pageInfo { hasNextPage endCursor }
			nodes {
				id sku name quantity
				variant { id }
				discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
			}
		}
	}
}`;

async function remainingLines(
	orderId: string,
	after: string | null | undefined,
) {
	const lines: (typeof lineItem.infer)[] = [];
	let cursor = after ?? null;
	while (cursor) {
		const page = linesPage.assert(
			await shopifyQuery(LINES_QUERY, { id: orderId, cursor }),
		);
		lines.push(...page.order.lineItems.nodes);
		cursor = page.order.lineItems.pageInfo.hasNextPage
			? (page.order.lineItems.pageInfo.endCursor ?? null)
			: null;
	}
	return lines;
}

const variantsPage = type({
	productVariants: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: type({
			id: "string",
			sku: "string | null",
			displayName: "string",
			product: {
				tags: "string[]",
				productType: "string",
				vendor: "string",
				status: "string",
			},
		}).array(),
	},
});

const VARIANTS_QUERY = `
query Variants($cursor: String) {
	productVariants(first: 250, after: $cursor) {
		pageInfo { hasNextPage endCursor }
		nodes { id sku displayName product { tags productType vendor status } }
	}
}`;

const shopInfo = type({ shop: { name: "string" } });

const shipFromInfo = type({
	shop: { name: "string", contactEmail: "string | null" },
	locations: {
		nodes: type({
			isPrimary: "boolean",
			address: {
				address1: "string | null",
				address2: "string | null",
				city: "string | null",
				provinceCode: "string | null",
				zip: "string | null",
				countryCode: "string | null",
				phone: "string | null",
			},
		}).array(),
	},
});

// Labels ship from the shop's primary Shopify location. Its address is copied
// onto our one owned location, so nobody types it in (or forgets to update
// it). With several owned locations katasync can't tell which is which, so it
// leaves them alone.
async function syncShipFrom(db: Db) {
	const owned = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"));
	if (owned.length !== 1) return;
	const info = shipFromInfo.assert(
		await shopifyQuery(
			"{ shop { name contactEmail } locations(first: 20) { nodes { isPrimary address { address1 address2 city provinceCode zip countryCode phone } } } }",
			{},
		),
	);
	const primary = info.locations.nodes.find((l) => l.isPrimary);
	if (!primary) return;
	await db
		.update(locations)
		.set({
			shipFromName: info.shop.name,
			address1: primary.address.address1,
			address2: primary.address.address2,
			city: primary.address.city,
			region: primary.address.provinceCode,
			postalCode: primary.address.zip,
			country: primary.address.countryCode,
			phone: primary.address.phone,
			email: info.shop.contactEmail,
		})
		.where(eq(locations.id, owned[0].id));
}

// Shopify's 60-day window is the furthest back read_orders reaches.
const FIRST_SYNC_DAYS = 60;

export async function syncShopify(
	db: Db,
	options: { listings: boolean } = { listings: true },
) {
	const { shop } = shopInfo.assert(await shopifyQuery("{ shop { name } }", {}));
	const store = await ensureStore(db, "shopify", shop.name);

	// Listings first, so order lines can resolve to products.
	let cursor: string | null = null;
	let variants = 0;
	if (options.listings)
		do {
			const page = variantsPage.assert(
				await shopifyQuery(VARIANTS_QUERY, { cursor }),
			);
			const nodes = page.productVariants.nodes;
			variants += nodes.length;
			await syncListings(
				db,
				store.id,
				nodes.map((v) => ({
					externalId: v.id,
					externalSku: v.sku || null,
					title: cleanTitle(v.displayName),
					fulfillment: "merchant" as const,
					tags: v.product.tags,
					productType: v.product.productType || null,
					vendor: v.product.vendor || null,
					status: v.product.status,
				})),
			);
			cursor = page.productVariants.pageInfo.hasNextPage
				? (page.productVariants.pageInfo.endCursor ?? null)
				: null;
		} while (cursor);
	if (options.listings) await syncShipFrom(db);
	const locationId = await shippingLocation(db);
	const matched = options.listings
		? await matchListings(db)
		: { mapped: [], created: 0, skipped: [] };
	// Orders that sold a newly matched listing pick up the product now.
	const caughtUp = await applyListingsToOrders(db, matched.mapped, locationId);

	const since =
		store.ordersSyncedThrough ??
		new Date(Date.now() - FIRST_SYNC_DAYS * 24 * 60 * 60 * 1000);
	const result = await ingestMatching(
		db,
		store,
		`updated_at:>='${since.toISOString()}'`,
		locationId,
	);
	await advanceOrderCursor(db, store.id, result.newest ?? since);
	return {
		store: store.name,
		variants,
		mapped: matched.mapped.length,
		created: matched.created,
		orders: result.count,
		problems: [...matched.skipped, ...caughtUp.problems, ...result.problems],
	};
}

// One-time history import: orders placed in the given window, by date
// placed rather than last change, so old orders that never change still
// come in. It never moves the sync cursor, and orders from before the stock
// snapshot are history only, so it can't touch stock.
export async function backfillShopify(db: Db, from: Date, until: Date) {
	const { shop } = shopInfo.assert(await shopifyQuery("{ shop { name } }", {}));
	const store = await ensureStore(db, "shopify", shop.name);
	const result = await ingestMatching(
		db,
		store,
		`created_at:>='${from.toISOString()}' created_at:<'${until.toISOString()}'`,
		await shippingLocation(db),
	);
	return { store: store.name, orders: result.count, problems: result.problems };
}

// Ingests every order matching a Shopify search, page by page.
async function ingestMatching(
	db: Db,
	store: Awaited<ReturnType<typeof ensureStore>>,
	search: string,
	locationId: number | null,
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
			const result = await ingestNode(db, store, o, locationId, tiktokDirect);
			if (!result) continue;
			problems.push(...result.problems);
			count++;
		}
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
	locationId: number | null,
	tiktokDirect: boolean,
) {
	if (tiktokDirect && tiktokOrderId(o.tags)) return null;
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
	return ingestOrder(db, store, toChannelOrder(order), locationId);
}

// One order by id, for a webhook. Read straight from the order rather than
// through search, which lags a few seconds behind new orders. It doesn't
// move the sync cursor; the next pass sees the order again and reports any
// problems with it on Diagnostics.
export async function ingestShopifyOrder(db: Db, orderId: string) {
	const { shop, order } = type({
		shop: { name: "string" },
		order: orderNode.or("null"),
	}).assert(
		await shopifyQuery(
			`query Order($id: ID!) { shop { name } order(id: $id) { ${ORDER_FIELDS} } }`,
			{ id: orderId },
		),
	);
	if (!order) return;
	const store = await ensureStore(db, "shopify", shop.name);
	await ingestNode(
		db,
		store,
		order,
		await shippingLocation(db),
		await hasTiktokStore(db),
	);
}

// The TikTok store exists once a direct TikTok sync has reached TikTok.
async function hasTiktokStore(db: Db) {
	const [row] = await db
		.select({ id: stores.id })
		.from(stores)
		.where(eq(stores.channel, "tiktok"))
		.limit(1);
	return Boolean(row);
}

// Shopify's TikTok channel tags each order "TikTokOrderID:<id>".
function tiktokOrderId(tags: string[]) {
	const tag = tags.find((t) => t.startsWith("TikTokOrderID:"));
	return tag ? `tiktok:${tag.slice("TikTokOrderID:".length)}` : null;
}

function toChannelOrder(o: typeof orderNode.infer): ChannelOrder {
	return {
		externalId: o.id,
		name: o.name,
		salesChannel:
			o.channelInformation?.channelDefinition?.channelName ??
			o.app?.name ??
			o.sourceName,
		marketplaceOrderId: tiktokOrderId(o.tags),
		placedAt: o.createdAt,
		cancelledAt: o.cancelledAt,
		fulfillmentStatus: o.displayFulfillmentStatus,
		fulfilledByChannel: false,
		financialStatus: o.displayFinancialStatus,
		customerName: o.shippingAddress?.name ?? null,
		shipCity: o.shippingAddress?.city ?? null,
		shipRegion: o.shippingAddress?.provinceCode ?? null,
		shipCountry: o.shippingAddress?.countryCodeV2 ?? null,
		shipAddress1: o.shippingAddress?.address1 ?? null,
		shipAddress2: o.shippingAddress?.address2 ?? null,
		shipPostalCode: o.shippingAddress?.zip ?? null,
		shipPhone: o.shippingAddress?.phone ?? null,
		total: o.totalPriceSet.shopMoney.amount,
		shippingCharged: o.totalShippingPriceSet.shopMoney.amount,
		sourceUpdatedAt: o.updatedAt,
		lines: o.lineItems.nodes.map((l) => ({
			externalId: l.id,
			listingExternalId: l.variant?.id ?? null,
			sku: l.sku || null,
			title: l.name,
			quantity: l.quantity,
			unitPrice: l.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount,
		})),
	};
}

const userErrors = type({
	field: "string[] | null",
	message: "string",
}).array();

const openFulfillmentOrders = type({
	order: type({
		fulfillmentOrders: {
			nodes: type({ id: "string", status: "string" }).array(),
		},
		fulfillments: type({
			id: "string",
			status: "string",
			trackingInfo: type({ number: "string | null" }).array(),
		}).array(),
	}).or("null"),
});

const fulfillmentCreated = type({
	fulfillmentCreate: {
		fulfillment: type({ id: "string" }).or("null"),
		userErrors,
	},
});

// Marks everything still open on the order as shipped with this tracking,
// and has Shopify email the customer. Returns Shopify's fulfillment id,
// which voiding needs. Safe to repeat: if this tracking number is already
// on the order (an earlier try got through), that fulfillment is returned
// instead of a second one. Needs write_merchant_managed_fulfillment_orders.
export async function shopifyFulfill(
	orderId: string,
	tracking: { company: string; number: string; url: string | null },
) {
	const { order } = openFulfillmentOrders.assert(
		await shopifyQuery(
			"query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status } } fulfillments(first: 50) { id status trackingInfo { number } } } }",
			{ id: orderId },
		),
	);
	if (!order) throw new Error("Shopify has no such order");
	const already = order.fulfillments.find(
		(f) =>
			f.status !== "CANCELLED" &&
			f.trackingInfo.some((t) => t.number === tracking.number),
	);
	if (already) return already.id;
	const open = order.fulfillmentOrders.nodes.filter((f) =>
		["OPEN", "IN_PROGRESS"].includes(f.status),
	);
	if (open.length === 0) {
		throw new Error("Shopify shows nothing left to ship on this order");
	}
	const { fulfillmentCreate } = fulfillmentCreated.assert(
		await shopifyQuery(
			"mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } } }",
			{
				fulfillment: {
					lineItemsByFulfillmentOrder: open.map((f) => ({
						fulfillmentOrderId: f.id,
					})),
					trackingInfo: {
						company: tracking.company,
						number: tracking.number,
						...(tracking.url ? { url: tracking.url } : {}),
					},
					notifyCustomer: true,
				},
			},
		),
	);
	if (
		fulfillmentCreate.userErrors.length > 0 ||
		!fulfillmentCreate.fulfillment
	) {
		throw new Error(
			`Shopify refused: ${fulfillmentCreate.userErrors.map((e) => e.message).join("; ")}`,
		);
	}
	return fulfillmentCreate.fulfillment.id;
}

const fulfillmentCancelled = type({
	fulfillmentCancel: { userErrors },
});

// Undoes shopifyFulfill after a label is voided: the order goes back to
// unfulfilled on Shopify.
export async function shopifyCancelFulfillment(fulfillmentId: string) {
	const { fulfillmentCancel } = fulfillmentCancelled.assert(
		await shopifyQuery(
			"mutation($id: ID!) { fulfillmentCancel(id: $id) { userErrors { field message } } }",
			{ id: fulfillmentId },
		),
	);
	if (fulfillmentCancel.userErrors.length > 0) {
		throw new Error(
			`Shopify refused: ${fulfillmentCancel.userErrors.map((e) => e.message).join("; ")}`,
		);
	}
}

// The storefront's tracking page looks labels up on Shippo, which wants
// Shippo's carrier token ("usps"), not the name Shopify shows ("USPS"). So
// each shipped label is also listed on the order, one entry per tracking
// number: metafield katasync.shippo_tracking, type json, value
// [{ "number": "9400...", "carrier": "usps", "url": "https://..." }]. url is
// the carrier's own tracking page, null when Shippo gave none; the shipping
// email links to the storefront's page instead. Needs write_orders.
export const shippoTrackingList = type({
	number: "string",
	carrier: "string",
	"url?": "string | null",
}).array();
export type ShippoTracking = typeof shippoTrackingList.infer;

const shippoTrackingRead = type({
	order: type({
		metafield: type({ value: "string", compareDigest: "string" }).or("null"),
	}).or("null"),
});

const metafieldsSaved = type({ metafieldsSet: { userErrors } });

// Each call gives up after this long. The fulfillment already went through,
// so a slow Shopify is noted rather than waited on.
const SHIPPO_TRACKING_TIMEOUT_MS = 5000;

// Reads the list, changes it, and writes it back only if Shopify still has
// what was read, so a concurrent edit fails instead of being lost.
async function changeShippoTracking(
	orderId: string,
	change: (list: ShippoTracking) => ShippoTracking,
) {
	const { order } = shippoTrackingRead.assert(
		await shopifyQuery(
			'query($id: ID!) { order(id: $id) { metafield(namespace: "katasync", key: "shippo_tracking") { value compareDigest } } }',
			{ id: orderId },
			{ timeoutMs: SHIPPO_TRACKING_TIMEOUT_MS },
		),
	);
	if (!order) throw new Error("Shopify has no such order");
	const current = order.metafield
		? shippoTrackingList.assert(JSON.parse(order.metafield.value))
		: [];
	const next = change(current);
	if (JSON.stringify(next) === JSON.stringify(current)) return;
	const { metafieldsSet } = metafieldsSaved.assert(
		await shopifyQuery(
			"mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }",
			{
				metafields: [
					{
						ownerId: orderId,
						namespace: "katasync",
						key: "shippo_tracking",
						type: "json",
						value: JSON.stringify(next),
						compareDigest: order.metafield?.compareDigest ?? null,
					},
				],
			},
			{ timeoutMs: SHIPPO_TRACKING_TIMEOUT_MS },
		),
	);
	if (metafieldsSet.userErrors.length > 0) {
		throw new Error(
			`Shopify refused: ${metafieldsSet.userErrors.map((e) => e.message).join("; ")}`,
		);
	}
}

// Adds a label to the order's list, replacing an entry with the same number.
export function shopifySaveShippoTracking(
	orderId: string,
	entry: ShippoTracking[number],
) {
	return changeShippoTracking(orderId, (list) => [
		...list.filter((e) => e.number !== entry.number),
		entry,
	]);
}

// Takes a voided label off the order's list. Nothing to do if it isn't there.
export function shopifyRemoveShippoTracking(orderId: string, number: string) {
	return changeShippoTracking(orderId, (list) =>
		list.filter((e) => e.number !== number),
	);
}
