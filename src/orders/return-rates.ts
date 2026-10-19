import { and, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLineReturns,
	orderReturnsDue,
	orders,
	productReturnRates,
	products,
	stores,
} from "#/db/schema";

// What Returns › Insights shows, from the order_line_returns and
// product_return_rates views (drizzle/0064, 0065).

// The views' settled year: orders placed 410 to 45 days ago, so each had
// time to come back. Must match product_return_rates; the tests check the
// totals agree.
const settled = and(
	gte(orderLineReturns.placedAt, sql`now() - interval '410 days'`),
	lt(orderLineReturns.placedAt, sql`now() - interval '45 days'`),
);

// What each channel tells us when something comes back. Only Amazon names
// returns (with a reason); the others only show up as full refunds.
export const evidence = {
	amazon: "Return requests, with reasons",
	shopify: "Full refunds only",
	ebay: "Full refunds only",
	tiktok: "Full refunds only",
} as const;

export async function returnInsights(db: Db) {
	const day = 24 * 60 * 60 * 1000;
	const window = {
		from: new Date(Date.now() - 410 * day),
		until: new Date(Date.now() - 45 * day),
	};
	const [channels, rates, lines, reasons] = await Promise.all([
		db
			.select({
				channel: orderLineReturns.soldOn,
				sold: sql<number>`sum(${orderLineReturns.sold})::int`,
				returned: sql<number>`sum(${orderLineReturns.returned})::int`,
			})
			.from(orderLineReturns)
			.where(settled)
			.groupBy(orderLineReturns.soldOn)
			.orderBy(desc(sql`sum(${orderLineReturns.sold})`)),
		db
			.select({
				productId: productReturnRates.productId,
				sku: productReturnRates.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				sold: productReturnRates.sold,
				returned: productReturnRates.returned,
				rate: productReturnRates.rate,
				rateLow: productReturnRates.rateLow,
				baseline: productReturnRates.baseline,
				expected: productReturnRates.expected,
				excess: productReturnRates.excess,
			})
			.from(productReturnRates)
			.innerJoin(products, eq(products.id, productReturnRates.productId))
			.where(gt(productReturnRates.returned, 0)),
		db
			.select({
				productId: orderLineReturns.productId,
				orderId: orderLineReturns.orderId,
				orderName: orders.name,
				channel: stores.channel,
				salesChannel: orders.salesChannel,
				placedAt: orderLineReturns.placedAt,
				sold: orderLineReturns.sold,
				returned: orderLineReturns.returned,
				received: orderLineReturns.received,
				requested: orderLineReturns.requested,
				refundedInFull: orderLineReturns.refundedInFull,
				reasons: orderLineReturns.reasons,
			})
			.from(orderLineReturns)
			.innerJoin(orders, eq(orders.id, orderLineReturns.orderId))
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(and(settled, gt(orderLineReturns.returned, 0)))
			.orderBy(desc(orderLineReturns.placedAt)),
		db
			.select({
				reason: sql<string>`r.reason`,
				lines: sql<number>`count(*)::int`,
			})
			.from(
				sql`${orderLineReturns}, unnest(${orderLineReturns.reasons}) as r(reason)`,
			)
			.where(settled)
			.groupBy(sql`r.reason`)
			.orderBy(desc(sql`count(*)`)),
	]);

	// Returned too often: even the lowest rate its numbers make likely is
	// above what its channels would bring, worst excess first. One return
	// isn't a pattern, however few sold, so those stand apart. The rest come
	// back only as often as their sales predict.
	const high = rates.filter((r) => r.rateLow > r.baseline);
	const flagged = high
		.filter((r) => r.returned > 1)
		.sort((a, b) => b.excess - a.excess || b.returned - a.returned);
	const once = high
		.filter((r) => r.returned === 1)
		.sort((a, b) => b.rate - a.rate);
	const expected = rates
		.filter((r) => r.rateLow <= r.baseline)
		.sort((a, b) => b.returned - a.returned);
	return {
		window,
		channels: channels.map((c) => ({ ...c, evidence: evidence[c.channel] })),
		flagged,
		once,
		expected,
		lines,
		reasons,
	};
}

export type ReturnInsights = Awaited<ReturnType<typeof returnInsights>>;
export type ReturnRate = ReturnInsights["flagged"][number];
export type ReturnedLine = ReturnInsights["lines"][number];

// Orders with something due back, for the sidebar.
export async function countReturnsDue(db: Db) {
	const [{ count }] = await db
		.select({
			count: sql<number>`count(distinct ${orderReturnsDue.orderId})::int`,
		})
		.from(orderReturnsDue);
	return count;
}
