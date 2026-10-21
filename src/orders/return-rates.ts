import {
	and,
	desc,
	eq,
	gt,
	gte,
	isNotNull,
	lt,
	ne,
	type SQL,
	sql,
} from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLineReturns,
	orderReturnsDue,
	orders,
	productReturnRates,
	products,
	returnRequestLines,
	returnRequests,
	stores,
} from "#/db/schema";
import { returnReasons } from "./return-reasons";

// What Returns › Insights shows, from the order_line_returns and
// product_return_rates views (drizzle/0064, 0066). Rates count orders: a
// buyer decides once however many are in the box.

// The views' settled year: orders placed 410 to 45 days ago, so each had
// time to come back. Must match product_return_rates; the tests check the
// totals agree.
export const settled = and(
	gte(orderLineReturns.placedAt, sql`now() - interval '410 days'`),
	lt(orderLineReturns.placedAt, sql`now() - interval '45 days'`),
);

// What each channel tells us when something comes back.
export const evidence = {
	amazon: "Return requests, with reasons",
	shopify: "Return requests, with reasons",
	ebay: "Return requests, with reasons",
	tiktok: "Return requests, with reasons",
} as const;

// Lines that came back among orders matching `placed`, newest first, each
// with what its buyers wrote.
export async function returnedLinesWhere(db: Db, placed: SQL | undefined) {
	const [lines, notes] = await Promise.all([
		db
			.select({
				lineId: orderLineReturns.lineId,
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
			.where(and(placed, gt(orderLineReturns.returned, 0)))
			.orderBy(desc(orderLineReturns.placedAt)),
		db
			.select({
				lineId: returnRequestLines.orderLineId,
				note: returnRequests.note,
			})
			.from(returnRequestLines)
			.innerJoin(
				returnRequests,
				eq(returnRequests.id, returnRequestLines.requestId),
			)
			.where(
				and(
					isNotNull(returnRequests.note),
					ne(returnRequests.status, "cancelled"),
				),
			),
	]);
	return lines.map((l) => ({
		...l,
		notes: notes.flatMap((n) =>
			n.lineId === l.lineId && n.note ? [n.note] : [],
		),
	}));
}

export async function returnInsights(db: Db) {
	const day = 24 * 60 * 60 * 1000;
	const window = {
		from: new Date(Date.now() - 410 * day),
		until: new Date(Date.now() - 45 * day),
	};
	const [channels, rates, lines] = await Promise.all([
		db
			.select({
				channel: orderLineReturns.soldOn,
				orders: sql<number>`count(distinct ${orderLineReturns.orderId})::int`,
				ordersReturned: sql<number>`count(distinct ${orderLineReturns.orderId}) filter (where ${orderLineReturns.returned} > 0)::int`,
				sold: sql<number>`sum(${orderLineReturns.sold})::int`,
			})
			.from(orderLineReturns)
			.where(settled)
			.groupBy(orderLineReturns.soldOn)
			.orderBy(desc(sql`count(distinct ${orderLineReturns.orderId})`)),
		db
			.select({
				productId: productReturnRates.productId,
				sku: productReturnRates.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				orders: productReturnRates.orders,
				ordersReturned: productReturnRates.ordersReturned,
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
		returnedLinesWhere(db, settled),
	]);

	// How many returned lines gave each reason, in plain words, so the same
	// reason from two channels counts once.
	const byReason = new Map<string, { text: string; lines: number }>();
	for (const l of lines)
		for (const r of returnReasons(l.reasons.join("; "))) {
			const seen = byReason.get(r.chip);
			byReason.set(r.chip, { text: r.text, lines: (seen?.lines ?? 0) + 1 });
		}
	const reasons = [...byReason]
		.map(([chip, r]) => ({ chip, ...r }))
		.sort((a, b) => b.lines - a.lines);

	// Returned too often: even the lowest rate its numbers make likely is
	// above what its channels would bring, worst excess first. One return
	// isn't a pattern, however few sold, so those stand apart. The rest come
	// back only as often as their sales predict.
	const high = rates.filter((r) => r.rateLow > r.baseline);
	const flagged = high
		.filter((r) => r.ordersReturned > 1)
		.sort((a, b) => b.excess - a.excess || b.ordersReturned - a.ordersReturned);
	const once = high
		.filter((r) => r.ordersReturned === 1)
		.sort((a, b) => b.rate - a.rate);
	const expected = rates
		.filter((r) => r.rateLow <= r.baseline)
		.sort((a, b) => b.ordersReturned - a.ordersReturned);
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
