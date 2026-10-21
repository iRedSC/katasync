import {
	type AnyColumn,
	and,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	sql,
} from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type ListingStockPush,
	listings,
	orderLineProfit,
	orderLineReturns,
	products,
	stores,
} from "#/db/schema";
import { getAvailability } from "#/inventory/availability";
import { onlineStock } from "#/inventory/online-stock";
import { profitByMarketplace, type Range } from "#/orders/profit";
import { settled } from "#/orders/return-rates";
import { MARKETS, type Market } from "./market";

export { MARKETS, type Market };

// What each marketplace sells and what to do about it, worked out for every
// market in one pass so the overview and each market's own tab agree.
// Sales are the Profit tab's: confirmed, shipped items (order_line_profit),
// by where they were sold, so TikTok orders Shopify relays count as TikTok.

// Each list stops here; the page is for what to act on first.
const LIST = 10;
// A product counts as slipping once it sold at least this many here in the
// period before and at most half that now.
const SLIPPING_FROM = 3;
// Returns: a rate needs this many orders before it says anything.
const RATE_FROM = 5;

// How a product's listings on one market stand, best first: a live listing
// wins over a draft, a draft over an ended one. Only a live listing can have
// a problem, and "shows 0" only counts while we have stock to sell.
export type ListingProblem =
	| { kind: "shows_zero" }
	| { kind: "push_failed"; error: string }
	| { kind: "unpushable"; reason: string };
export type ListingState =
	| { kind: "live"; problem: ListingProblem | null }
	| { kind: "draft" }
	| { kind: "ended" }
	| { kind: "none" };

export type ProductInfo = {
	productId: number;
	sku: string;
	name: string;
	variantName: string | null;
	imageUrl: string | null;
	// Sellable units on our shelves (a bundle's from its parts).
	available: number;
};

type Sales = { units: number; revenue: number; profit: number; unsure: number };
const none: Sales = { units: 0, revenue: 0, profit: 0, unsure: 0 };

export type BestSeller = ProductInfo &
	Sales & { unitsBefore: number; listing: ListingState };
export type Unlisted = ProductInfo &
	Sales & {
		// Where it sells instead, biggest first.
		soldOn: Market[];
		listing: Exclude<ListingState, { kind: "live" }>;
	};
export type Losing = ProductInfo &
	Sales & {
		// Its margin on the other markets, null when it didn't sell there.
		marginElsewhere: number | null;
	};
export type Slipping = ProductInfo & {
	units: number;
	unitsBefore: number;
	listing: ListingState;
};
export type ToFix = ProductInfo & {
	revenue: number;
	listing: Extract<ListingState, { kind: "live" | "ended" | "draft" }>;
};
export type Returned = ProductInfo & {
	orders: number;
	ordersReturned: number;
	rate: number;
	// Its rate on the other markets, null with too few orders there to say.
	rateElsewhere: number | null;
};

export type MarketTotals = Awaited<
	ReturnType<typeof profitByMarketplace>
>[number];

export type MarketDetail = {
	market: Market;
	connected: boolean;
	totals: MarketTotals | null;
	previous: MarketTotals | null;
	// This market's part of all sales in the range, 0 to 1.
	share: number;
	// Orders over the settled year (orders placed 410 to 45 days ago).
	returns: { orders: number; ordersReturned: number };
	best: BestSeller[];
	unlisted: Unlisted[];
	losing: Losing[];
	slipping: Slipping[];
	toFix: ToFix[];
	// How many there are in all; the lists stop at LIST.
	counts: { unlisted: number; losing: number; toFix: number };
	returned: Returned[];
};

const lp = orderLineProfit;
const money = (column: AnyColumn) =>
	sql<number>`coalesce(sum(${column}), 0)::float8`;

async function salesByProduct(db: Db, start: Date, end: Date) {
	return db
		.select({
			productId: sql<number>`${lp.productId}`,
			soldOn: lp.soldOn,
			units: sql<number>`sum(${lp.quantity})::int`,
			revenue: money(lp.revenue),
			profit: money(lp.profit),
			unsure: sql<number>`(count(*) filter (where not ${lp.complete}))::int`,
		})
		.from(lp)
		.where(
			and(
				gte(lp.placedAt, start),
				lt(lp.placedAt, end),
				eq(lp.shipped, true),
				isNotNull(lp.productId),
			),
		)
		.groupBy(lp.productId, lp.soldOn);
}

type SalesRow = Awaited<ReturnType<typeof salesByProduct>>[number];

// product → market → sales
function byProduct(rows: SalesRow[]) {
	const map = new Map<number, Map<Market, Sales>>();
	for (const r of rows) {
		const markets = map.get(r.productId) ?? new Map<Market, Sales>();
		markets.set(r.soldOn, {
			units: r.units,
			revenue: r.revenue,
			profit: r.profit,
			unsure: r.unsure,
		});
		map.set(r.productId, markets);
	}
	return map;
}

function add(a: Sales, b: Sales): Sales {
	return {
		units: a.units + b.units,
		revenue: a.revenue + b.revenue,
		profit: a.profit + b.profit,
		unsure: a.unsure + b.unsure,
	};
}

const rank = (s: ListingState) =>
	s.kind === "live" ? (s.problem ? 1 : 0) : s.kind === "draft" ? 2 : 3;

// One listing's state. "shows_zero" is decided later, against stock.
export function listingState(l: {
	status: string | null;
	goneAt: Date | null;
	fulfillment: "merchant" | "fba";
	stockPush: ListingStockPush | null;
}): Exclude<ListingState, { kind: "none" }> {
	const status = (l.status ?? "").toUpperCase();
	if (l.goneAt || ["DELETED", "ARCHIVED", "INACTIVE"].includes(status))
		return { kind: "ended" };
	if (status === "DRAFT") return { kind: "draft" };
	// Amazon stocks and ships FBA listings; their quantity isn't ours.
	const sp = l.fulfillment === "fba" ? null : l.stockPush;
	if (sp?.state === "unpushable")
		return {
			kind: "live",
			problem: { kind: "unpushable", reason: sp.reason },
		};
	if (sp?.state === "ready" && sp.error)
		return {
			kind: "live",
			problem: { kind: "push_failed", error: sp.error },
		};
	if (sp?.state === "ready" && sp.shows === 0)
		return { kind: "live", problem: { kind: "shows_zero" } };
	return { kind: "live", problem: null };
}

// The best of a product's listings on a market, with "shows 0" dropped
// when there's nothing to sell anyway.
export function bestListing(
	states: Exclude<ListingState, { kind: "none" }>[],
	available: number,
): ListingState {
	const fixed = states.map((s) =>
		s.kind === "live" && s.problem?.kind === "shows_zero" && available <= 0
			? { kind: "live" as const, problem: null }
			: s,
	);
	return fixed.sort((a, b) => rank(a) - rank(b))[0] ?? { kind: "none" };
}

export async function marketAnalytics(
	db: Db,
	range: Range,
): Promise<MarketDetail[]> {
	const [
		now,
		before,
		totals,
		previous,
		connected,
		listingRows,
		returnRows,
		marketReturns,
	] = await Promise.all([
		salesByProduct(db, range.start, range.end),
		salesByProduct(db, range.previousStart, range.previousEnd),
		profitByMarketplace(db, range.start, range.end),
		profitByMarketplace(db, range.previousStart, range.previousEnd),
		db.selectDistinct({ channel: stores.channel }).from(stores),
		db
			.select({
				productId: sql<number>`${listings.productId}`,
				channel: stores.channel,
				status: listings.status,
				goneAt: listings.goneAt,
				fulfillment: listings.fulfillment,
				stockPush: listings.stockPush,
			})
			.from(listings)
			.innerJoin(stores, eq(stores.id, listings.storeId))
			.where(isNotNull(listings.productId)),
		db
			.select({
				productId: orderLineReturns.productId,
				soldOn: orderLineReturns.soldOn,
				orders: sql<number>`count(distinct ${orderLineReturns.orderId})::int`,
				ordersReturned: sql<number>`(count(distinct ${orderLineReturns.orderId}) filter (where ${orderLineReturns.returned} > 0))::int`,
			})
			.from(orderLineReturns)
			.where(settled)
			.groupBy(orderLineReturns.productId, orderLineReturns.soldOn),
		// Once per order, however many products it held.
		db
			.select({
				soldOn: orderLineReturns.soldOn,
				orders: sql<number>`count(distinct ${orderLineReturns.orderId})::int`,
				ordersReturned: sql<number>`(count(distinct ${orderLineReturns.orderId}) filter (where ${orderLineReturns.returned} > 0))::int`,
			})
			.from(orderLineReturns)
			.where(settled)
			.groupBy(orderLineReturns.soldOn),
	]);

	const salesNow = byProduct(now);
	const salesBefore = byProduct(before);

	// product → market → its listings' states
	const listed = new Map<
		number,
		Map<Market, Exclude<ListingState, { kind: "none" }>[]>
	>();
	for (const l of listingRows) {
		const markets = listed.get(l.productId) ?? new Map();
		markets.set(l.channel, [
			...(markets.get(l.channel) ?? []),
			listingState(l),
		]);
		listed.set(l.productId, markets);
	}

	// Market → products sold there before and now, either period, for the
	// listings that need fixing.
	const soldRecently = new Map<Market, Set<number>>();
	for (const r of [...now, ...before]) {
		const set = soldRecently.get(r.soldOn) ?? new Set<number>();
		set.add(r.productId);
		soldRecently.set(r.soldOn, set);
	}

	const productIds = [
		...new Set([
			...salesNow.keys(),
			...salesBefore.keys(),
			...returnRows.map((r) => r.productId),
		]),
	];
	const [info, available] = await Promise.all([
		productIds.length === 0
			? []
			: db
					.select({
						id: products.id,
						sku: products.sku,
						name: products.name,
						variantName: products.variantName,
						imageUrl: products.imageUrl,
						archived: sql<boolean>`${products.archivedAt} is not null`,
					})
					.from(products)
					.where(inArray(products.id, productIds)),
		onlineStock(db).then((from) => getAvailability(db, productIds, from)),
	]);
	const product = new Map(
		info.map((p) => [
			p.id,
			{
				productId: p.id,
				sku: p.sku,
				name: p.name,
				variantName: p.variantName,
				imageUrl: p.imageUrl,
				available: available.get(p.id) ?? 0,
				archived: p.archived,
			},
		]),
	);
	const infoOf = (id: number): ProductInfo | null => {
		const p = product.get(id);
		if (!p) return null;
		const { archived: _, ...rest } = p;
		return rest;
	};
	const listingOn = (id: number, market: Market) =>
		bestListing(
			listed.get(id)?.get(market) ?? [],
			product.get(id)?.available ?? 0,
		);

	const allRevenue = totals.reduce((s, t) => s + t.revenue, 0);
	const markets = MARKETS.filter(
		(m) =>
			connected.some((c) => c.channel === m) ||
			totals.some((t) => t.soldOn === m),
	);

	return markets.map((market): MarketDetail => {
		const here = (sales: Map<number, Map<Market, Sales>>, id: number) =>
			sales.get(id)?.get(market) ?? none;
		const elsewhere = (id: number) => {
			let sum = none;
			for (const [m, s] of salesNow.get(id) ?? [])
				if (m !== market) sum = add(sum, s);
			return sum;
		};
		const ids = (sales: Map<number, Map<Market, Sales>>) =>
			[...sales.keys()].filter((id) => product.has(id));

		const best = ids(salesNow)
			.filter((id) => here(salesNow, id).units > 0)
			.map((id) => ({ id, s: here(salesNow, id) }))
			.sort((a, b) => b.s.revenue - a.s.revenue || b.s.units - a.s.units)
			.slice(0, LIST)
			.flatMap(({ id, s }) => {
				const p = infoOf(id);
				return p
					? [
							{
								...p,
								...s,
								unitsBefore: here(salesBefore, id).units,
								listing: listingOn(id, market),
							},
						]
					: [];
			});

		// Only what we could ship today: listing something we're out of
		// sells nothing.
		const unlisted = ids(salesNow)
			.filter((id) => {
				const p = product.get(id);
				return p && !p.archived && p.available > 0;
			})
			.flatMap((id) => {
				const listing = listingOn(id, market);
				if (listing.kind === "live") return [];
				const s = elsewhere(id);
				if (s.units <= 0) return [];
				const soldOn = [...(salesNow.get(id) ?? [])]
					.filter(([m]) => m !== market)
					.sort((a, b) => b[1].revenue - a[1].revenue)
					.map(([m]) => m);
				const p = infoOf(id);
				return p ? [{ ...p, ...s, soldOn, listing }] : [];
			})
			.sort((a, b) => b.revenue - a.revenue);

		const losing = ids(salesNow)
			.flatMap((id) => {
				const s = here(salesNow, id);
				if (s.units <= 0 || s.profit >= 0) return [];
				const other = elsewhere(id);
				const p = infoOf(id);
				return p
					? [
							{
								...p,
								...s,
								marginElsewhere:
									other.revenue > 0 ? other.profit / other.revenue : null,
							},
						]
					: [];
			})
			.sort((a, b) => a.profit - b.profit);

		const slipping = ids(salesBefore)
			.flatMap((id) => {
				const was = here(salesBefore, id).units;
				const is = here(salesNow, id).units;
				if (was < SLIPPING_FROM || is > was / 2) return [];
				const p = infoOf(id);
				return p
					? [
							{
								...p,
								units: is,
								unitsBefore: was,
								listing: listingOn(id, market),
							},
						]
					: [];
			})
			.sort(
				(a, b) =>
					b.unitsBefore - b.units - (a.unitsBefore - a.units) ||
					b.unitsBefore - a.unitsBefore,
			)
			.slice(0, LIST);

		// Listings that sold here lately and now can't while we have stock,
		// or say they have none while we do. Biggest sellers first.
		const toFix = [...(soldRecently.get(market) ?? [])]
			.flatMap((id): ToFix[] => {
				const listing = listingOn(id, market);
				if (listing.kind === "none") return [];
				if (listing.kind === "live" && !listing.problem) return [];
				const p = infoOf(id);
				if (!p || product.get(id)?.archived) return [];
				// Ended or a draft while we're out is a stock problem, which
				// Products shows; it's a listing to fix once there's stock.
				if (listing.kind !== "live" && p.available <= 0) return [];
				const revenue =
					here(salesNow, id).revenue + here(salesBefore, id).revenue;
				return [{ ...p, revenue, listing }];
			})
			.sort((a, b) => b.revenue - a.revenue);

		const rates = new Map<
			number,
			{ here: [number, number]; other: [number, number] }
		>();
		for (const r of returnRows) {
			const entry = rates.get(r.productId) ?? {
				here: [0, 0],
				other: [0, 0],
			};
			const side = r.soldOn === market ? entry.here : entry.other;
			side[0] += r.orders;
			side[1] += r.ordersReturned;
			rates.set(r.productId, entry);
		}
		const returned = [...rates]
			.flatMap(([id, { here: h, other: o }]): Returned[] => {
				if (h[1] < 2 || h[0] < RATE_FROM) return [];
				const rate = h[1] / h[0];
				const rateElsewhere = o[0] >= RATE_FROM ? o[1] / o[0] : null;
				// Only worth a look when it comes back here more than elsewhere.
				if (rateElsewhere !== null && rate <= rateElsewhere) return [];
				const p = infoOf(id);
				return p
					? [
							{
								...p,
								orders: h[0],
								ordersReturned: h[1],
								rate,
								rateElsewhere,
							},
						]
					: [];
			})
			.sort((a, b) => b.ordersReturned - a.ordersReturned || b.rate - a.rate)
			.slice(0, LIST);

		const t = totals.find((r) => r.soldOn === market) ?? null;
		return {
			market,
			connected: connected.some((c) => c.channel === market),
			totals: t,
			previous: previous.find((r) => r.soldOn === market) ?? null,
			share: t && allRevenue > 0 ? t.revenue / allRevenue : 0,
			returns: marketReturns.find((r) => r.soldOn === market) ?? {
				orders: 0,
				ordersReturned: 0,
			},
			best,
			unlisted: unlisted.slice(0, LIST),
			losing: losing.slice(0, LIST),
			slipping,
			toFix: toFix.slice(0, LIST),
			counts: {
				unlisted: unlisted.length,
				losing: losing.length,
				toFix: toFix.length,
			},
			returned,
		};
	});
}
