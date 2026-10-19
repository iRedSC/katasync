import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orderLineReturns, products } from "#/db/schema";
import { returnedLinesWhere } from "./return-rates";

// What came back lately, for Returns › Insights. Rates leave out the last
// 45 days so every order has had time to come back; this is the other side:
// orders from the last 90 days, so a problem shows while it's still fresh.
// Its counts are still filling in, so there's no rate, only how many
// orders came back and why.

export const RECENT_DAYS = 90;

export async function recentReturns(db: Db) {
	const placed = gte(
		orderLineReturns.placedAt,
		sql`now() - make_interval(days => ${RECENT_DAYS})`,
	);
	const lines = await returnedLinesWhere(db, placed);
	const ids = [...new Set(lines.map((l) => l.productId))];
	if (ids.length === 0) return [];
	const totals = await db
		.select({
			productId: orderLineReturns.productId,
			sku: products.sku,
			name: products.name,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
			orders: sql<number>`count(distinct ${orderLineReturns.orderId})::int`,
			ordersReturned: sql<number>`count(distinct ${orderLineReturns.orderId}) filter (where ${orderLineReturns.returned} > 0)::int`,
		})
		.from(orderLineReturns)
		.innerJoin(products, eq(products.id, orderLineReturns.productId))
		.where(and(placed, inArray(orderLineReturns.productId, ids)))
		.groupBy(
			orderLineReturns.productId,
			products.sku,
			products.name,
			products.variantName,
			products.imageUrl,
		);
	// Most returned orders first, then whichever came back last.
	const latest = (id: number) =>
		Math.max(
			...lines
				.filter((l) => l.productId === id)
				.map((l) => new Date(l.placedAt).getTime()),
		);
	return totals
		.map((t) => ({
			...t,
			lines: lines.filter((l) => l.productId === t.productId),
		}))
		.sort(
			(a, b) =>
				b.ordersReturned - a.ordersReturned ||
				latest(b.productId) - latest(a.productId),
		);
}

export type RecentReturn = Awaited<ReturnType<typeof recentReturns>>[number];
