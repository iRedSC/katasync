import { and, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orderLines, orders, products, supplierOffers } from "#/db/schema";
import { soldByDay } from "#/inventory/sales";
import type { DemandWindow } from "#/purchasing/forecast";
import type { SetRecipeRow } from "#/purchasing/sets";
import {
	earnings,
	type OrderTake,
	type SetProfit,
	YEAR_DAYS,
} from "./priority";

const DAY_MS = 86_400_000;

// What priority reads about profit over the last year: each stocked
// product's own orders and each tool set's, each order's profit at today's
// cost, dated from the demand window's first day (older ones negative). A set's sale is the set's, never its parts' too, so no dollar is
// counted twice. Cancelled and FBA orders are left out: an FBA sale never
// waited on our shelf.
export type Profits = {
	// Stocked products with a cost. One without can't be valued, so it has
	// no priority rather than a low one.
	own: Map<number, OrderTake[]>;
	priced: Set<number>;
	// A unit's cost, for ranking what hasn't sold.
	costOf: Map<number, number | null>;
	// Each set's day of profit, for its parts.
	setsOf: Map<number, SetProfit[]>;
};

export async function loadProfits(
	db: Db,
	window: DemandWindow,
	recipes: SetRecipeRow[],
): Promise<Profits> {
	const yearStart = new Date(window.end.getTime() - YEAR_DAYS * DAY_MS);
	const [lines, costs] = await Promise.all([
		db
			.select({
				orderId: orderLines.orderId,
				productId: orderLines.productId,
				kind: products.kind,
				day: sql<number>`floor(extract(epoch from (${orders.placedAt} - ${window.start})) / 86400)::int`,
				units: orderLines.quantity,
				price: sql<number>`${orderLines.unitPrice}::float8`,
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.innerJoin(products, eq(products.id, orderLines.productId))
			.where(
				and(
					gte(orders.placedAt, yearStart),
					lt(orders.placedAt, window.end),
					isNull(orders.cancelledAt),
					eq(orders.fulfilledByChannel, false),
				),
			),
		// A unit's cost as ABC reads it: the cheapest supplier's per item, else
		// what we last valued it at.
		db
			.select({
				id: products.id,
				cost: sql<
					number | null
				>`coalesce(${supplierOffers.itemCost}, ${products.unitCost})::float8`,
			})
			.from(products)
			.leftJoin(
				supplierOffers,
				and(
					eq(supplierOffers.productId, products.id),
					eq(supplierOffers.cheapest, true),
				),
			)
			// Everything with its own stock: kits too, not tool sets.
			.where(ne(products.kind, "bundle")),
	]);
	const costOf = new Map(costs.map((c) => [c.id, c.cost]));
	const recipeOf = new Map<number, SetRecipeRow[]>();
	for (const r of recipes)
		recipeOf.set(r.setId, [...(recipeOf.get(r.setId) ?? []), r]);
	// A set's cost from its recipe today, null when a part has none.
	const setCost = (setId: number) => {
		const parts = recipeOf.get(setId) ?? [];
		if (parts.length === 0) return null;
		let sum = 0;
		for (const p of parts) {
			const c = costOf.get(p.productId);
			if (c === null || c === undefined) return null;
			sum += p.perSet * c;
		}
		return sum;
	};

	// Profit per (product, order), on the day the order was placed.
	const takes = new Map<number, Map<number, OrderTake>>();
	for (const l of lines) {
		if (l.productId === null) continue;
		const cost =
			l.kind === "bundle" ? setCost(l.productId) : costOf.get(l.productId);
		if (cost === null || cost === undefined) continue;
		const byOrder = takes.get(l.productId) ?? new Map<number, OrderTake>();
		const take = byOrder.get(l.orderId) ?? { day: l.day, profit: 0 };
		take.profit += l.units * (l.price - cost);
		byOrder.set(l.orderId, take);
		takes.set(l.productId, byOrder);
	}

	// Sets are never out of stock themselves.
	const days = Math.round(
		(window.end.getTime() - window.start.getTime()) / DAY_MS,
	);
	const allOpen = Array.from({ length: days }, () => true);
	const own = new Map<number, OrderTake[]>();
	const setsOf = new Map<number, SetProfit[]>();
	for (const [setId, parts] of recipeOf) {
		const sales = [...(takes.get(setId)?.values() ?? [])];
		if (sales.length === 0) continue;
		const set: SetProfit = {
			setId,
			orders: sales.length,
			daily: earnings({ orders: sales, open: allOpen, sets: [] }).own,
		};
		for (const p of parts)
			setsOf.set(p.productId, [...(setsOf.get(p.productId) ?? []), set]);
	}
	for (const [id, byOrder] of takes)
		if (!recipeOf.has(id)) own.set(id, [...byOrder.values()]);
	const priced = new Set(costs.flatMap((c) => (c.cost === null ? [] : [c.id])));
	return { own, priced, costOf, setsOf };
}

// Units sold over the last 7, 30, 90, 180 and 365 days, today included,
// counted as reorder counts them (sets as their parts, no FBA).
export type Sales = {
	d7: number;
	d30: number;
	d90: number;
	d180: number;
	d365: number;
};

export const NO_SALES: Sales = { d7: 0, d30: 0, d90: 0, d180: 0, d365: 0 };

export async function loadSales(db: Db, window: DemandWindow) {
	const end = window.end.getTime();
	const since = new Date(end - YEAR_DAYS * DAY_MS);
	const sales = new Map<number, Sales>();
	for (const r of await soldByDay(db, since)) {
		const ago = (end - Date.parse(`${r.day}T00:00:00Z`)) / DAY_MS;
		if (ago <= 0 || ago > YEAR_DAYS) continue;
		const s = sales.get(r.productId) ?? { ...NO_SALES };
		s.d365 += r.units;
		if (ago <= 180) s.d180 += r.units;
		if (ago <= 90) s.d90 += r.units;
		if (ago <= 30) s.d30 += r.units;
		if (ago <= 7) s.d7 += r.units;
		sales.set(r.productId, s);
	}
	return sales;
}
