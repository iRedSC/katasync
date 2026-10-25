import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { dispatchOrders, orders, shipments, stores } from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import { FEEDS, hasFeed } from "#/diagnostics/feed-health";
import { recordFeed } from "#/diagnostics/feed-record";
import { errorText } from "#/diagnostics/runs";

// The tracking feed of each channel katasync sends tracking to, counted at
// each tracking sweep (src/routes/api/cron/tracking.ts): every live label's
// tracking reached the marketplace, or which orders' it still hasn't.
// Server only.

const tracked = (Object.keys(FEEDS) as SyncedChannel[]).filter((c) =>
	hasFeed(c, "tracking"),
);

// Runs the sweep, counts it on each tracking feed, and returns what it did.
// A sweep that throws fails every one of them, and is thrown again.
export async function sweepingTracking<T>(db: Db, sweep: () => Promise<T>) {
	const startedAt = new Date();
	let result: { ok: true; value: T } | { ok: false; error: unknown };
	try {
		result = { ok: true, value: await sweep() };
	} catch (error) {
		result = { ok: false, error };
	}
	const failed = result.ok ? null : errorText(result.error);
	const refused = failed ? [] : await refusedHandoffs(db);
	for (const channel of tracked)
		await recordFeed(
			db,
			channel,
			"tracking",
			startedAt,
			failed
				? { kind: "failed", error: failed }
				: {
						kind: "read",
						problems: refused
							.filter((r) => r.channel === channel)
							.map((r) => `${r.orderName}: ${r.error}`),
					},
		);
	if (!result.ok) throw result.error;
	return result.value;
}

// Live labels whose tracking a marketplace refused and that are still
// unsent, as Diagnostics lists them.
function refusedHandoffs(db: Db) {
	return db
		.select({
			channel: stores.channel,
			orderName: orders.name,
			error: sql<string>`${dispatchOrders.channelError}`,
		})
		.from(dispatchOrders)
		.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(
			and(
				isNotNull(dispatchOrders.channelError),
				isNull(dispatchOrders.channelSentAt),
				sql`exists (select 1 from ${shipments} where ${shipments.dispatchId} = ${dispatchOrders.dispatchId} and ${shipments.voidedAt} is null and not ${shipments.test})`,
			),
		);
}
