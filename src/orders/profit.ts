import {
	type AnyColumn,
	and,
	desc,
	eq,
	gte,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLineProfit,
	orderLines,
	orderProfit,
	orders,
	products,
} from "#/db/schema";

// Profit over a stretch of time, from the order_profit and order_line_profit
// views (drizzle/0050_order_profit.sql, 0051_order_line_profit.sql). Days
// and weeks are the shop's, in Eastern time, and weeks start on Saturday.

export const TIME_ZONE = "America/New_York";

export const RANGES = {
	today: "Today",
	yesterday: "Yesterday",
	this_week: "This week",
	last_week: "Last week",
	this_month: "This month",
	last_month: "Last month",
	last_30_days: "Last 30 days",
	last_90_days: "Last 90 days",
	this_year: "This year",
} as const;
export type RangeKey = keyof typeof RANGES;

// Each range in shop-local time `l` (now), and how far back the one it's
// compared with is. Ranges still running compare with the same stretch of
// the one before ("this month so far" against last month to the same day).
const BOUNDS: Record<RangeKey, { start: string; end: string; back: string }> = {
	today: { start: "date_trunc('day', l)", end: "l", back: "1 day" },
	yesterday: {
		start: "date_trunc('day', l) - interval '1 day'",
		end: "date_trunc('day', l)",
		back: "1 day",
	},
	// date_trunc's weeks start Monday; two days on, Saturday starts them.
	this_week: {
		start: "date_trunc('week', l + interval '2 days') - interval '2 days'",
		end: "l",
		back: "7 days",
	},
	last_week: {
		start: "date_trunc('week', l + interval '2 days') - interval '9 days'",
		end: "date_trunc('week', l + interval '2 days') - interval '2 days'",
		back: "7 days",
	},
	this_month: { start: "date_trunc('month', l)", end: "l", back: "1 month" },
	last_month: {
		start: "date_trunc('month', l) - interval '1 month'",
		end: "date_trunc('month', l)",
		back: "1 month",
	},
	last_30_days: {
		start: "date_trunc('day', l) - interval '29 days'",
		end: "l",
		back: "30 days",
	},
	last_90_days: {
		start: "date_trunc('day', l) - interval '89 days'",
		end: "l",
		back: "90 days",
	},
	this_year: { start: "date_trunc('year', l)", end: "l", back: "1 year" },
};

export type Range = {
	start: Date;
	end: Date;
	previousStart: Date;
	previousEnd: Date;
};

export async function resolveRange(
	db: Db,
	key: RangeKey,
	now = new Date(),
): Promise<Range> {
	const b = BOUNDS[key];
	const tz = sql.raw(`'${TIME_ZONE}'`);
	const start = sql.raw(b.start);
	const end = sql.raw(b.end);
	const back = sql.raw(`interval '${b.back}'`);
	const result = (await db.execute(sql`
		with n as (select (${now.toISOString()}::timestamptz at time zone ${tz}) as l)
		select
			(${start}) at time zone ${tz} as "start",
			(${end}) at time zone ${tz} as "end",
			(${start} - ${back}) at time zone ${tz} as "previousStart",
			(${end} - ${back}) at time zone ${tz} as "previousEnd"
		from n
	`)) as unknown as { rows: Record<keyof Range, string | Date>[] };
	const row = result.rows[0];
	return {
		start: new Date(row.start),
		end: new Date(row.end),
		previousStart: new Date(row.previousStart),
		previousEnd: new Date(row.previousEnd),
	};
}

const p = orderProfit;
const lp = orderLineProfit;
const sum = (column: AnyColumn) =>
	sql<number>`coalesce(sum(${column}), 0)::float8`;
const count = (where: ReturnType<typeof sql>) =>
	sql<number>`(count(*) filter (where ${where}))::int`;

const totalsFields = {
	orders: sql<number>`count(*)::int`,
	revenue: sum(p.revenue),
	shippingCharged: sum(p.shippingCharged),
	cost: sum(p.cost),
	fees: sum(p.fees),
	labels: sum(p.labels),
	refunds: sum(p.refunds),
	adjustments: sum(p.adjustments),
	profit: sum(p.profit),
	complete: count(sql`${p.complete}`),
	completeProfit: sql<number>`coalesce(sum(${p.profit}) filter (where ${p.complete}), 0)::float8`,
	// What makes the total less sure, so the page can say so.
	estimatedFees: sql<number>`coalesce(sum(${p.fees}) filter (where ${p.feesStatus} = 'estimated'), 0)::float8`,
	feesEstimated: count(sql`${p.feesStatus} = 'estimated'`),
	labelsMissing: count(sql`${p.labelsStatus} = 'missing'`),
	labelsStandIn: count(sql`${p.labelsStatus} = 'stand_in'`),
	labelsAwaiting: count(sql`${p.labelsStatus} = 'awaiting'`),
	costUnknown: count(sql`not ${p.costKnown}`),
};

export type ProfitTotals = {
	[K in keyof typeof totalsFields]: number;
};

const within = (start: Date, end: Date) =>
	and(gte(p.placedAt, start), lt(p.placedAt, end));

export async function profitTotals(db: Db, start: Date, end: Date) {
	const [row] = await db.select(totalsFields).from(p).where(within(start, end));
	return row as ProfitTotals;
}

export async function profitByMarketplace(db: Db, start: Date, end: Date) {
	return db
		.select({ soldOn: p.soldOn, ...totalsFields })
		.from(p)
		.where(within(start, end))
		.groupBy(p.soldOn)
		.orderBy(desc(sum(p.revenue)));
}

// One row per shop-local day in the range, days without orders included.
export async function profitByDay(db: Db, start: Date, end: Date) {
	const tz = sql.raw(`'${TIME_ZONE}'`);
	const result = (await db.execute(sql`
		with days as (
			select generate_series(
				date_trunc('day', ${start.toISOString()}::timestamptz at time zone ${tz}),
				${end.toISOString()}::timestamptz at time zone ${tz} - interval '1 microsecond',
				interval '1 day'
			)::date as day
		)
		select
			to_char(d.day, 'YYYY-MM-DD') as day,
			coalesce(sum(p.revenue), 0)::float8 as revenue,
			coalesce(sum(p.profit), 0)::float8 as profit,
			count(p.order_id)::int as orders
		from days d
		left join order_profit p
			on (p.placed_at at time zone ${tz})::date = d.day
			and p.placed_at >= ${start.toISOString()}::timestamptz
			and p.placed_at < ${end.toISOString()}::timestamptz
		group by d.day
		order by d.day
	`)) as unknown as {
		rows: { day: string; revenue: number; profit: number; orders: number }[];
	};
	return result.rows;
}

// Profit per product, from each item sold (order_line_profit). Tool sets
// rank as the set they were sold as. Lines with no product aren't ranked, so
// these don't add up to the total.
export async function profitByProduct(db: Db, start: Date, end: Date) {
	return db
		.select({
			sku: products.sku,
			name: products.name,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
			units: sql<number>`sum(${lp.quantity})::int`,
			revenue: sum(lp.revenue),
			profit: sum(lp.profit),
			// Sales whose profit rests on something unknown.
			unsure: count(sql`not ${lp.complete}`),
		})
		.from(lp)
		.innerJoin(products, eq(products.id, lp.productId))
		.where(and(gte(lp.placedAt, start), lt(lp.placedAt, end)))
		.groupBy(products.id);
}

// More items than this in a range and the list says it stopped short.
export const ITEMS_LIMIT = 5000;

// Every item sold and shipped in the range, newest first, with what it
// made, and how many items wait to ship. An unshipped sale's label and
// fees are still to come, so it isn't listed yet.
export async function profitItems(db: Db, start: Date, end: Date) {
	const rows = await db
		.select({
			lineId: lp.lineId,
			orderId: lp.orderId,
			orderName: orders.name,
			soldOn: lp.soldOn,
			placedAt: lp.placedAt,
			productId: lp.productId,
			sku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
			name: sql<string>`coalesce(${products.name}, ${orderLines.title})`,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
			productKind: products.kind,
			quantity: lp.quantity,
			restocked: lp.restocked,
			revenue: lp.revenue,
			cost: lp.cost,
			costKnown: lp.costKnown,
			fees: lp.fees,
			labels: lp.labels,
			shippingCharged: lp.shippingCharged,
			refunds: lp.refunds,
			adjustments: lp.adjustments,
			profit: lp.profit,
			feesStatus: lp.feesStatus,
			labelsStatus: lp.labelsStatus,
			complete: lp.complete,
		})
		.from(lp)
		.innerJoin(orders, eq(orders.id, lp.orderId))
		.innerJoin(orderLines, eq(orderLines.id, lp.lineId))
		.leftJoin(products, eq(products.id, lp.productId))
		.where(
			and(
				gte(lp.placedAt, start),
				lt(lp.placedAt, end),
				ne(lp.labelsStatus, "not_shipped"),
			),
		)
		.orderBy(desc(lp.placedAt), lp.lineId)
		.limit(ITEMS_LIMIT + 1);
	const [{ unshipped }] = await db
		.select({ unshipped: sql<number>`coalesce(sum(${lp.quantity}), 0)::int` })
		.from(lp)
		.where(
			and(
				gte(lp.placedAt, start),
				lt(lp.placedAt, end),
				eq(lp.labelsStatus, "not_shipped"),
			),
		);
	return {
		items: rows.slice(0, ITEMS_LIMIT),
		cut: rows.length > ITEMS_LIMIT,
		unshipped,
	};
}

// Orders whose profit can't be trusted until someone acts: a shipped order
// with no label cost from anyone, or a line with no cost.
export async function ordersNeedingCosts(db: Db, start: Date, end: Date) {
	return db
		.select({
			id: orders.id,
			name: orders.name,
			soldOn: p.soldOn,
			placedAt: p.placedAt,
			revenue: p.revenue,
			labelsStatus: p.labelsStatus,
			costKnown: p.costKnown,
		})
		.from(p)
		.innerJoin(orders, eq(orders.id, p.orderId))
		.where(
			and(
				within(start, end),
				or(eq(p.labelsStatus, "missing"), eq(p.costKnown, false)),
			),
		)
		.orderBy(desc(p.placedAt))
		.limit(50);
}
