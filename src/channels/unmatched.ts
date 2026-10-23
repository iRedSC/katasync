import {
	type AnyColumn,
	and,
	eq,
	isNotNull,
	isNull,
	max,
	type SQL,
	sql,
} from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	listings,
	orderLines,
	orders,
	productAliases,
	products,
	stores,
	supplierOffers,
} from "#/db/schema";
import { LedgerError } from "#/inventory/ledger";
import { carried } from "#/products/archive";
import { lockListings } from "./listing-claims";
import {
	type Candidate,
	type MatchReason,
	normalizeTitle,
	rankCandidates,
} from "./match-rank";

type Channel = (typeof stores.$inferSelect)["channel"];

// One thing channels sell that no product backs: every unmatched listing
// itemKey says is the same item. Resolving it resolves all its listings.
export type UnmatchedItem = {
	listingIds: number[];
	title: string;
	sku: string | null;
	channels: Channel[];
	fba: boolean;
	units: number;
	orders: number;
	lastSoldAt: Date | null;
	candidates: {
		sku: string;
		name: string;
		variantName: string | null;
		imageUrl: string | null;
		reason: MatchReason;
	}[];
};

// A Shopify listing tagged "intangible" sells no stock (labor, a catalog):
// it never needs a product, and its sales cost nothing (order_line_costs).
export const intangible = sql`exists (select 1 from unnest(${listings.tags}) t where lower(t) = 'intangible')`;

// A draft, or a listing deleted (TikTok), archived (Shopify), or gone from
// its channel, can't sell now, so until it sells it doesn't need a product;
// a draft comes back once it's published. One that sold still does, for its
// past orders.
const unsellableUnsold = sql`((coalesce(${listings.status}, '') in ('DRAFT', 'DELETED', 'ARCHIVED') or ${listings.goneAt} is not null) and not exists (select 1 from ${orderLines} join ${orders} on ${orders.id} = ${orderLines.orderId} where ${orders.storeId} = ${listings.storeId} and ${orderLines.listingExternalId} = ${listings.externalId}))`;

// Listings still waiting for a product.
export const awaitingProduct = and(
	isNull(listings.productId),
	sql`not ${intangible}`,
	sql`not ${unsellableUnsold}`,
);

// An order line whose listing is waiting for a product. Custom items have no
// listing and never wait.
export function lineAwaitsMatch(line: {
	productId: AnyColumn;
	storeId: AnyColumn;
	listingExternalId: AnyColumn;
}) {
	return sql<boolean>`(${line.productId} is null and exists (select 1 from ${listings} where ${listings.storeId} = ${line.storeId} and ${listings.externalId} = ${line.listingExternalId} and ${awaitingProduct}))`;
}

// Unmatched items, most units sold first. With an order, only the items
// that order sold.
export async function listUnmatched(
	db: Db,
	scope: { orderId?: number } = {},
): Promise<UnmatchedItem[]> {
	const sold = db
		.select({
			storeId: orders.storeId,
			listingExternalId: orderLines.listingExternalId,
			units: sql<number>`sum(${orderLines.quantity})::int`.as("units"),
			orders: sql<number>`count(distinct ${orders.id})::int`.as("orders"),
			lastSoldAt: max(orders.placedAt).as("last_sold_at"),
		})
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.where(isNull(orders.cancelledAt))
		.groupBy(orders.storeId, orderLines.listingExternalId)
		.as("sold");
	const onOrder =
		scope.orderId === undefined
			? null
			: db
					.select({ storeId: orders.storeId, id: orderLines.listingExternalId })
					.from(orderLines)
					.innerJoin(orders, eq(orders.id, orderLines.orderId))
					.where(eq(orders.id, scope.orderId))
					.as("on_order");
	let query = db
		.select({
			id: listings.id,
			channel: stores.channel,
			externalSku: listings.externalSku,
			title: listings.title,
			fulfillment: listings.fulfillment,
			key: itemKey,
			units: sql<number>`coalesce(${sold.units}, 0)`,
			orders: sql<number>`coalesce(${sold.orders}, 0)`,
			lastSoldAt: sold.lastSoldAt,
		})
		.from(listings)
		.innerJoin(stores, eq(stores.id, listings.storeId))
		.leftJoin(
			sold,
			and(
				eq(sold.storeId, listings.storeId),
				eq(sold.listingExternalId, listings.externalId),
			),
		)
		.$dynamic();
	if (onOrder)
		query = query.innerJoin(
			onOrder,
			and(
				eq(onOrder.storeId, listings.storeId),
				eq(onOrder.id, listings.externalId),
			),
		);
	const rows = await query.where(awaitingProduct);

	const groups = new Map<string, typeof rows>();
	for (const r of rows) {
		groups.set(r.key, [...(groups.get(r.key) ?? []), r]);
	}
	if (groups.size === 0) return [];

	const catalog = await loadCatalog(db);
	const before = await matchedTitles(db);
	return [...groups.values()]
		.map((g): UnmatchedItem => {
			// The best-selling listing names the item.
			const lead = [...g].sort((a, b) => b.units - a.units)[0];
			const last = g
				.map((r) => r.lastSoldAt)
				.filter((d): d is Date => d !== null)
				.sort((a, b) => b.getTime() - a.getTime())[0];
			const title = lead.title.replace(/ - Default Title$/, "");
			const sku = lead.externalSku?.trim() || null;
			const fba = g.some((r) => r.fulfillment === "fba");
			return {
				listingIds: g.map((r) => r.id).sort((a, b) => a - b),
				title,
				sku,
				channels: [...new Set(g.map((r) => r.channel))],
				fba,
				units: g.reduce((n, r) => n + r.units, 0),
				orders: g.reduce((n, r) => n + r.orders, 0),
				lastSoldAt: last ?? null,
				candidates: rankCandidates(
					{
						title,
						sku,
						fba,
						matchedBefore: before.get(normalizeTitle(title)) ?? [],
					},
					catalog,
				).map(({ candidate: c, reason }) => ({
					sku: c.sku,
					name: c.name,
					variantName: c.variantName,
					imageUrl: c.imageUrl,
					reason,
				})),
			};
		})
		.sort(
			(a, b) =>
				b.units - a.units ||
				b.orders - a.orders ||
				a.title.localeCompare(b.title),
		);
}

async function loadCatalog(db: Db) {
	const [rows, aliases, skus] = await Promise.all([
		db
			.select({
				id: products.id,
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				kind: products.kind,
			})
			.from(products)
			.where(carried),
		db.select().from(productAliases),
		// Every supplier's part number for it, since a listing may use any.
		db
			.select({
				productId: supplierOffers.productId,
				supplierSku: supplierOffers.supplierSku,
			})
			.from(supplierOffers)
			.where(isNotNull(supplierOffers.supplierSku)),
	]);
	const codes = new Map<number, string[]>();
	for (const a of aliases)
		codes.set(a.productId, [...(codes.get(a.productId) ?? []), a.alias]);
	for (const s of skus)
		if (s.supplierSku)
			codes.set(s.productId, [
				...(codes.get(s.productId) ?? []),
				s.supplierSku,
			]);
	return rows.map((p): Candidate & { imageUrl: string | null } => ({
		productId: p.id,
		sku: p.sku,
		name: p.name,
		variantName: p.variantName,
		imageUrl: p.imageUrl,
		kind: p.kind,
		codes: [...new Set(codes.get(p.id) ?? [])],
	}));
}

// Products already sold under each listing title, so a title matched on one
// channel suggests the same product on the next.
async function matchedTitles(db: Db) {
	const rows = await db
		.select({ title: listings.title, productId: listings.productId })
		.from(listings)
		.where(isNotNull(listings.productId));
	const byTitle = new Map<string, number[]>();
	for (const r of rows) {
		if (r.productId === null) continue;
		const key = normalizeTitle(r.title);
		const ids = byTitle.get(key) ?? [];
		if (!ids.includes(r.productId)) byTitle.set(key, [...ids, r.productId]);
	}
	return byTitle;
}

// The likely products for any title and SKU, e.g. one an agent read off an
// invoice or a listing it's looking at.
export async function suggestProducts(
	db: Db,
	input: { title: string; sku: string | null; fba?: boolean },
	limit = 10,
) {
	const [catalog, before] = await Promise.all([
		loadCatalog(db),
		matchedTitles(db),
	]);
	return rankCandidates(
		{
			title: input.title,
			sku: input.sku,
			fba: input.fba ?? false,
			matchedBefore: before.get(normalizeTitle(input.title)) ?? [],
		},
		catalog,
		limit,
	).map(({ candidate: c, reason }) => ({
		sku: c.sku,
		name: c.name,
		variantName: c.variantName,
		kind: c.kind,
		reason,
	}));
}

// The listings an item is made of, all still unmatched, locked until the
// transaction ends so the caller can match them. Refused when any has been
// matched since, so a stale screen or a racing match can't remap one. Call it
// inside a transaction.
export async function unmatchedListings(tx: Db, listingIds: number[]) {
	const rows = await lockListings(tx, listingIds);
	const matched = rows.filter((r) => r.productId !== null);
	if (matched.length > 0)
		throw new LedgerError(
			`Already matched: ${matched.map((r) => r.title).join(", ")}`,
		);
	return rows;
}

// A title as listings are compared by: lowercase words and digits, with
// fractions spelled out first, so "1½" (1 1 2) and "1¼" (1 1 4) stay apart.
const titleKey = (title: AnyColumn | SQL) =>
	sql`btrim(regexp_replace(lower(normalize(regexp_replace(${title}, ' - Default Title$', ''), NFKD)), '[^a-z0-9]+', ' ', 'g'))`;

// Which listings are one item: the same SKU; or with no SKU, the same title
// on different stores (one item on Shopify and on TikTok). A title two
// SKU-less listings share within one store, like a product's variants, says
// nothing about which item is which, so each of those stands alone. One
// expression for both listing and counting, so the two can't disagree.
const itemKey = sql<string>`(case
	when ${listings.externalSku} ~ '[^[:space:]]' then 'sku:' || lower(regexp_replace(${listings.externalSku}, '^[[:space:]]+|[[:space:]]+$', '', 'g'))
	when exists (select 1 from ${listings} other where other.store_id = ${listings.storeId} and other.id <> ${listings.id} and coalesce(other.external_sku, '') !~ '[^[:space:]]' and ${titleKey(sql`other.title`)} = ${titleKey(listings.title)}) then 'listing:' || ${listings.id}
	else 'title:' || ${titleKey(listings.title)} end)`;

export async function countUnmatched(db: Db) {
	const [{ items }] = await db
		.select({ items: sql<number>`count(distinct ${itemKey})::int` })
		.from(listings)
		.where(awaitingProduct);
	return items;
}
