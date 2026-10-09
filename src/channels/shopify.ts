import { type } from "arktype";
import { and, desc, eq, max } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, movements, stores } from "#/db/schema";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { autoMapListings, syncListings } from "./listings";

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
async function shopifyQuery(query: string, variables: Record<string, unknown>) {
	const { domain, token } = credentials();
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(
			`https://${domain}/admin/api/${API_VERSION}/graphql.json`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Shopify-Access-Token": token,
				},
				body: JSON.stringify({ query, variables }),
			},
		);
		if (!response.ok) {
			throw new Error(
				`Shopify answered ${response.status}: ${await response.text()}`,
			);
		}
		const body = graphqlResponse.assert(await response.json());
		const throttled = body.errors?.some(
			(e) => e.extensions?.code === "THROTTLED",
		);
		if (throttled && attempt < 6) {
			await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
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

const ordersPage = type({
	orders: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: type({
			id: "string",
			name: "string",
			sourceName: "string | null",
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
				city: "string | null",
				provinceCode: "string | null",
				countryCodeV2: "string | null",
			}).or("null"),
			lineItems: {
				pageInfo: { hasNextPage: "boolean" },
				nodes: type({
					id: "string",
					sku: "string | null",
					name: "string",
					quantity: "number.integer",
					variant: type({ id: "string" }).or("null"),
					discountedUnitPriceAfterAllDiscountsSet: money,
				}).array(),
			},
		}).array(),
	},
});

const ORDERS_QUERY = `
query Orders($cursor: String, $query: String) {
	orders(first: 25, after: $cursor, sortKey: UPDATED_AT, query: $query) {
		pageInfo { hasNextPage endCursor }
		nodes {
			id name createdAt updatedAt cancelledAt sourceName
			app { name }
			channelInformation { channelDefinition { channelName } }
			displayFulfillmentStatus displayFinancialStatus
			totalPriceSet { shopMoney { amount } }
			totalShippingPriceSet { shopMoney { amount } }
			shippingAddress { name city provinceCode countryCodeV2 }
			lineItems(first: 30) {
				pageInfo { hasNextPage }
				nodes {
					id sku name quantity
					variant { id }
					discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
				}
			}
		}
	}
}`;

const variantsPage = type({
	productVariants: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: type({
			id: "string",
			sku: "string | null",
			displayName: "string",
		}).array(),
	},
});

const VARIANTS_QUERY = `
query Variants($cursor: String) {
	productVariants(first: 250, after: $cursor) {
		pageInfo { hasNextPage endCursor }
		nodes { id sku displayName }
	}
}`;

const shopInfo = type({ shop: { name: "string" } });

// The katasync store row for this Shopify shop. A new store starts taking
// stock from the most recent opening balance, since anything sold before that
// is already reflected in it.
async function getStore(db: Db) {
	const { shop } = shopInfo.assert(await shopifyQuery("{ shop { name } }", {}));
	const [existing] = await db
		.select()
		.from(stores)
		.where(and(eq(stores.channel, "shopify"), eq(stores.name, shop.name)));
	if (existing) return existing;
	const [{ openedAt }] = await db
		.select({ openedAt: max(movements.createdAt) })
		.from(movements)
		.where(eq(movements.reason, "opening_balance"));
	const [created] = await db
		.insert(stores)
		.values({ channel: "shopify", name: shop.name, stockFrom: openedAt })
		.returning();
	return created;
}

// Shopify's 60-day window is the furthest back read_orders reaches.
const FIRST_SYNC_DAYS = 60;

export async function syncShopify(
	db: Db,
	options: { listings: boolean } = { listings: true },
) {
	const store = await getStore(db);

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
					title: v.displayName,
					fulfillment: "merchant" as const,
				})),
			);
			cursor = page.productVariants.pageInfo.hasNextPage
				? (page.productVariants.pageInfo.endCursor ?? null)
				: null;
		} while (cursor);
	const mapped = options.listings ? await autoMapListings(db) : 0;

	// Stock comes from the one location we own; with several, katasync can't
	// guess, so it reports instead of taking stock from the wrong shelf.
	const owned = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"))
		.orderBy(desc(locations.id));
	const locationId = owned.length === 1 ? owned[0].id : null;

	const since =
		store.ordersSyncedThrough ??
		new Date(Date.now() - FIRST_SYNC_DAYS * 24 * 60 * 60 * 1000);
	const search = `updated_at:>='${since.toISOString()}'`;
	let newest = since;
	let count = 0;
	const problems: string[] = [];
	cursor = null;
	do {
		const page = ordersPage.assert(
			await shopifyQuery(ORDERS_QUERY, { cursor, query: search }),
		);
		for (const o of page.orders.nodes) {
			if (o.lineItems.pageInfo.hasNextPage) {
				problems.push(
					`${o.name}: more than 30 lines; only the first 30 came in`,
				);
			}
			const result = await ingestOrder(
				db,
				store,
				toChannelOrder(o),
				locationId,
			);
			problems.push(...result.problems);
			if (o.updatedAt > newest) newest = o.updatedAt;
			count++;
		}
		cursor = page.orders.pageInfo.hasNextPage
			? (page.orders.pageInfo.endCursor ?? null)
			: null;
	} while (cursor);

	await db
		.update(stores)
		.set({ ordersSyncedThrough: newest })
		.where(eq(stores.id, store.id));
	return { store: store.name, variants, mapped, orders: count, problems };
}

function toChannelOrder(
	o: (typeof ordersPage.infer.orders.nodes)[number],
): ChannelOrder {
	return {
		externalId: o.id,
		name: o.name,
		salesChannel:
			o.channelInformation?.channelDefinition?.channelName ??
			o.app?.name ??
			o.sourceName,
		placedAt: o.createdAt,
		cancelledAt: o.cancelledAt,
		fulfillmentStatus: o.displayFulfillmentStatus,
		financialStatus: o.displayFinancialStatus,
		customerName: o.shippingAddress?.name ?? null,
		shipCity: o.shippingAddress?.city ?? null,
		shipRegion: o.shippingAddress?.provinceCode ?? null,
		shipCountry: o.shippingAddress?.countryCodeV2 ?? null,
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
