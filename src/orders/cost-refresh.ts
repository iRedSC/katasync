import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type channel,
	orderCostChecks,
	orderCostReports,
	orders,
	stores,
} from "#/db/schema";
import { type CostReport, saveCostReport } from "./charges";

// Asks each marketplace again about orders whose charges aren't final yet.
// Marketplaces post fees and label costs days after the sale, revise them
// (TikTok settles a week or more later), and refunds come later still, so
// young orders are asked often and older ones rarely, until the order is old
// enough that what's on file is taken as final.
//
// A marketplace that can list what it posted lately (Amazon) is also swept
// each pass: an order with money posted since its report is asked again at
// once, however old. A carrier re-billing a label posts weeks after the sale,
// up to 60 days for Amazon, when the order's turn may be days off or past.

type Channel = (typeof channel.enumValues)[number];

const HOUR = 60 * 60 * 1000;
// Long enough for most returns to be refunded.
export const FINAL_AFTER_MS = 60 * 24 * HOUR;
const LONGEST_WAIT = 7 * 24 * HOUR;
// Each pass asks about this many orders at most, so one channel's backlog
// can't run past the cron's time limit or its API's rate limit.
const PER_PASS = 30;

export type DueOrder = {
	orderId: number;
	name: string;
	// The ID the billing marketplace knows the order by: Shopify's order GID,
	// or the marketplace's own order ID for everything else (a relayed TikTok
	// order's TikTok ID, not its Shopify one).
	marketplaceId: string;
	placedAt: Date;
};

// What a marketplace says about each order it's asked about. report is null
// when it has nothing yet (its finance report lags the sale); null is not
// "charged nothing", which is a report with no charges. A failed order has
// error instead and doesn't stop the rest.
export type FetchedCharges =
	| {
			orderId: number;
			report: Pick<
				CostReport,
				"settled" | "noLabel" | "labelsPending" | "charges"
			> | null;
	  }
	| { orderId: number; error: string };

// Asks about a batch at once, for marketplaces that can (ShopifyQL takes 50
// order IDs per query); eachOrder wraps a one-at-a-time API.
export type ChargeFetcher = (orders: DueOrder[]) => Promise<FetchedCharges[]>;

// Each order a marketplace posted money on since a time, by the ID it knows
// the order by, with when it last did.
export type PostedLister = (
	since: Date,
) => Promise<{ marketplaceId: string; postedAt: Date }[]>;

export function eachOrder(
	fetchOne: (
		order: DueOrder,
	) => Promise<Pick<
		CostReport,
		"settled" | "noLabel" | "labelsPending" | "charges"
	> | null>,
): ChargeFetcher {
	return async (due) => {
		const results: FetchedCharges[] = [];
		for (const order of due) {
			try {
				results.push({ orderId: order.orderId, report: await fetchOne(order) });
			} catch (e) {
				results.push({ orderId: order.orderId, error: errorText(e) });
			}
		}
		return results;
	};
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Orders to ask about now. With `history`, instead the orders already old
// enough to be final that were never asked about, or whose last ask failed
// an hour or more ago: a one-time catch-up of what came before (pnpm sync
// --costs-history), asked once each unless it failed.
export async function dueOrders(
	db: Db,
	billedBy: Channel,
	now: Date,
	limit = PER_PASS,
	history = false,
): Promise<DueOrder[]> {
	const finalFrom = new Date(now.getTime() - FINAL_AFTER_MS);
	const age = sql`extract(epoch from (${now}::timestamptz - ${orders.placedAt})) * 1000`;
	const rows = await db
		.select({
			orderId: orders.id,
			name: orders.name,
			externalId: orders.externalId,
			marketplaceOrderId: orders.marketplaceOrderId,
			storeChannel: stores.channel,
			placedAt: orders.placedAt,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.leftJoin(
			orderCostChecks,
			and(
				eq(orderCostChecks.orderId, orders.id),
				eq(orderCostChecks.billedBy, billedBy),
			),
		)
		.where(
			and(
				or(
					eq(stores.channel, billedBy),
					sql`${orders.marketplaceOrderId} like ${`${billedBy}:%`}`,
				),
				isNull(orders.cancelledAt),
				history
					? and(
							lt(orders.placedAt, finalFrom),
							// Never asked, or the last ask failed an hour or more ago.
							or(
								isNull(orderCostChecks.checkedAt),
								and(
									isNotNull(orderCostChecks.error),
									lt(orderCostChecks.checkedAt, new Date(now.getTime() - HOUR)),
								),
							),
						)
					: and(
							gte(orders.placedAt, finalFrom),
							// Asked again after a quarter of the order's age, between an
							// hour and a week: about 30 asks over the window, not one per
							// pass. Settled ones too, since a refund can follow settlement.
							or(
								isNull(orderCostChecks.checkedAt),
								sql`extract(epoch from (${now}::timestamptz - ${orderCostChecks.checkedAt})) * 1000
									>= greatest(${HOUR}, least(${LONGEST_WAIT}, ${age} / 4))`,
							),
						),
			),
		)
		// Never-asked orders first, then the newest.
		.orderBy(
			sql`${orderCostChecks.checkedAt} nulls first`,
			desc(orders.placedAt),
		)
		.limit(limit);
	return rows.map((r) => toDue(billedBy, r));
}

function toDue(
	billedBy: Channel,
	r: {
		orderId: number;
		name: string;
		externalId: string;
		marketplaceOrderId: string | null;
		storeChannel: Channel;
		placedAt: Date;
	},
): DueOrder {
	return {
		orderId: r.orderId,
		name: r.name,
		marketplaceId:
			billedBy === "shopify" && r.storeChannel === "shopify"
				? r.externalId
				: (r.marketplaceOrderId?.slice(billedBy.length + 1) ?? r.externalId),
		placedAt: r.placedAt,
	};
}

// Amazon's finances can show a posting up to 48 hours late, so a report
// fetched within that of it may not have it yet; such an order is asked again
// every 12 hours until a report comes after it. Each sweep looks back past
// that, with room for a few failed passes.
const SHOWS_UP_WITHIN_MS = 48 * HOUR;
const UNSURE_EVERY_MS = 12 * HOUR;
export const SWEEP_BACK_MS = 3 * 24 * HOUR;

// The orders with money posted after their report on file was fetched (or
// with none on file), or too soon after to be sure it's in, cancelled ones
// aside.
export async function postedOrders(
	db: Db,
	billedBy: Channel,
	posted: { marketplaceId: string; postedAt: Date }[],
	now: Date,
): Promise<DueOrder[]> {
	const latest = new Map<string, number>();
	for (const p of posted) {
		const t = p.postedAt.getTime();
		latest.set(p.marketplaceId, Math.max(t, latest.get(p.marketplaceId) ?? t));
	}
	if (latest.size === 0) return [];
	const ids = [...latest.keys()];
	const rows = await db
		.select({
			orderId: orders.id,
			name: orders.name,
			externalId: orders.externalId,
			marketplaceOrderId: orders.marketplaceOrderId,
			storeChannel: stores.channel,
			placedAt: orders.placedAt,
			fetchedAt: orderCostReports.fetchedAt,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.leftJoin(
			orderCostReports,
			and(
				eq(orderCostReports.orderId, orders.id),
				eq(orderCostReports.billedBy, billedBy),
			),
		)
		.where(
			and(
				isNull(orders.cancelledAt),
				or(
					and(eq(stores.channel, billedBy), inArray(orders.externalId, ids)),
					inArray(
						orders.marketplaceOrderId,
						ids.map((id) => `${billedBy}:${id}`),
					),
				),
			),
		);
	return rows
		.map((r) => ({ due: toDue(billedBy, r), fetchedAt: r.fetchedAt }))
		.filter(({ due, fetchedAt }) => {
			const postedAt = latest.get(due.marketplaceId);
			if (postedAt === undefined) return false;
			if (!fetchedAt || fetchedAt.getTime() < postedAt) return true;
			return (
				fetchedAt.getTime() < postedAt + SHOWS_UP_WITHIN_MS &&
				now.getTime() - fetchedAt.getTime() >= UNSURE_EVERY_MS
			);
		})
		.map(({ due }) => due);
}

// One pass for one marketplace. One order failing doesn't stop the rest; its
// error is kept on its check for Diagnostics and it's asked again later.
export async function refreshCosts(
	db: Db,
	billedBy: Channel,
	fetchCharges: ChargeFetcher,
	options: { now?: Date; limit?: number; history?: boolean } = {},
) {
	const now = options.now ?? new Date();
	const due = await dueOrders(
		db,
		billedBy,
		now,
		options.limit,
		options.history,
	);
	return askAbout(db, billedBy, fetchCharges, due, now);
}

// Asks again about every order the marketplace posted money on lately whose
// report on file came before it, however old the order. In batches, each
// saved as it's done, until `until`: a backlog (the first sweep, an outage)
// carries over to the next pass instead of running past the cron's limit.
export async function sweepPosted(
	db: Db,
	billedBy: Channel,
	fetchCharges: ChargeFetcher,
	listPosted: PostedLister,
	options: { now?: Date; until?: number; limit?: number } = {},
) {
	const now = options.now ?? new Date();
	const limit = options.limit ?? PER_PASS;
	const posted = await listPosted(new Date(now.getTime() - SWEEP_BACK_MS));
	const due = await postedOrders(db, billedBy, posted, now);
	const total = { checked: 0, reported: 0, problems: [] as string[] };
	for (let i = 0; i < due.length; i += limit) {
		const batch = await askAbout(
			db,
			billedBy,
			fetchCharges,
			due.slice(i, i + limit),
			now,
		);
		total.checked += batch.checked;
		total.reported += batch.reported;
		total.problems.push(...batch.problems);
		// Every order failing is likely an outage; more would fail the same.
		const allFailed = batch.problems.length >= batch.checked;
		if (allFailed || Date.now() >= (options.until ?? Infinity)) break;
	}
	return total;
}

async function askAbout(
	db: Db,
	billedBy: Channel,
	fetchCharges: ChargeFetcher,
	due: DueOrder[],
	now: Date,
) {
	let reported = 0;
	const problems: string[] = [];
	if (due.length === 0) return { checked: 0, reported, problems };
	let results: FetchedCharges[];
	try {
		results = await fetchCharges(due);
	} catch (e) {
		// The whole batch failed (a login, an outage): every order says so.
		results = due.map((o) => ({ orderId: o.orderId, error: errorText(e) }));
	}
	const byOrder = new Map(results.map((r) => [r.orderId, r]));
	for (const order of due) {
		const result = byOrder.get(order.orderId) ?? {
			orderId: order.orderId,
			error: "The marketplace didn't answer for this order",
		};
		let error = "error" in result ? result.error : null;
		if (!("error" in result) && result.report) {
			try {
				await saveCostReport(db, {
					...result.report,
					orderId: order.orderId,
					billedBy,
					fetchedAt: now,
				});
				reported++;
			} catch (e) {
				error = errorText(e);
			}
		}
		if (error) problems.push(`${order.name}: ${error}`);
		await db
			.insert(orderCostChecks)
			.values({ orderId: order.orderId, billedBy, checkedAt: now, error })
			.onConflictDoUpdate({
				target: [orderCostChecks.orderId, orderCostChecks.billedBy],
				set: { checkedAt: now, error },
			});
	}
	return { checked: due.length, reported, problems };
}
