import { type } from "arktype";
import {
	cleanTitle,
	fillProductImages,
	matchListings,
	syncListings,
} from "#/channels/listings";
import { shopifyQuery } from "#/channels/shopify/client";
import { ingestMatching } from "#/channels/shopify/ingest";
import { syncShipFrom } from "#/channels/shopify/ship-from";
import {
	advanceOrderCursor,
	ensureStore,
	shippingLocation,
} from "#/channels/stores";
import type { Db } from "#/db/client";
import { applyListingsToOrders } from "#/orders/remap";
import { importReturns } from "#/orders/return-requests";
import { fetchShopifyReturns } from "./shopify/returns";

export { shopifyQuery };
export {
	shopifyLineQuantity,
	shopifyToChannelOrder,
} from "#/channels/shopify/channel-order";
export {
	shopifyCancelFulfillment,
	shopifyFulfill,
} from "#/channels/shopify/fulfillment";
export { ingestShopifyOrder } from "#/channels/shopify/ingest";
export type { ShopifyOrder } from "#/channels/shopify/order-shapes";
export type { ShippoTracking } from "#/channels/shopify/shippo-tracking";
export {
	shippoTrackingList,
	shopifyRemoveShippoTracking,
	shopifySaveShippoTracking,
} from "#/channels/shopify/shippo-tracking";

const variantsPage = type({
	productVariants: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: type({
			id: "string",
			sku: "string | null",
			displayName: "string",
			image: type({ url: "string" }).or("null"),
			product: {
				tags: "string[]",
				productType: "string",
				vendor: "string",
				status: "string",
				featuredMedia: type({
					preview: { image: type({ url: "string" }).or("null") },
				}).or("null"),
			},
		}).array(),
	},
});

const VARIANTS_QUERY = `
query Variants($cursor: String) {
	productVariants(first: 250, after: $cursor) {
		pageInfo { hasNextPage endCursor }
		nodes {
			id sku displayName image { url }
			product { tags productType vendor status featuredMedia { preview { image { url } } } }
		}
	}
}`;

const shopInfo = type({ shop: { name: "string" } });

// Shopify's 60-day window is the furthest back read_orders reaches.
const FIRST_SYNC_DAYS = 60;

const DAY = 24 * 60 * 60 * 1000;
const RETURNS_DAYS = 7;

export async function syncShopify(
	db: Db,
	options: { listings: boolean } = { listings: true },
) {
	const { shop } = shopInfo.assert(await shopifyQuery("{ shop { name } }", {}));
	const store = await ensureStore(db, "shopify", shop.name);

	// Listings first, so order lines can resolve to products.
	let cursor: string | null = null;
	let variants = 0;
	// The variant's own photo, else its product's main one.
	const images: { externalId: string; imageUrl: string }[] = [];
	if (options.listings)
		do {
			const page = variantsPage.assert(
				await shopifyQuery(VARIANTS_QUERY, { cursor }),
			);
			const nodes = page.productVariants.nodes;
			variants += nodes.length;
			for (const v of nodes) {
				const url = v.image?.url ?? v.product.featuredMedia?.preview.image?.url;
				if (url) images.push({ externalId: v.id, imageUrl: url });
			}
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
	const photographed = await fillProductImages(db, store.id, images);
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
	// Returns after orders, so a return on a new order finds it. Every
	// listings pass rereads the last week, so a missed pass loses nothing.
	const returns = options.listings
		? await importReturns(db, store, () =>
				fetchShopifyReturns(new Date(Date.now() - RETURNS_DAYS * DAY)),
			)
		: [];
	return {
		store: store.name,
		variants,
		mapped: matched.mapped.length,
		created: matched.created,
		photographed,
		orders: result.count,
		problems: [
			...matched.skipped,
			...caughtUp.problems,
			...result.problems,
			...returns,
		],
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
