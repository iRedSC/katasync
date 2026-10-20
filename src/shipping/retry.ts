import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "#/db/client";
import { dispatchOrders } from "#/db/schema";
import { live, type Outside, sendTracking } from "./handoff";

// Sends again the tracking a marketplace refused, once each send's retry is
// due. Run by followUpTracking, the orders page's sync and a four-hourly
// sweep (src/routes/api/cron/tracking.ts). Each due send is
// claimed before it's tried, so two runs never try the same one; a refusal
// sets its next try (see tell in handoff.ts), or none once ten minutes have
// passed, which leaves it on Diagnostics with a retry button.
export async function retryDueTracking(
	db: Db,
	now = new Date(),
	outside: Outside = live,
) {
	const claimed = await db
		.update(dispatchOrders)
		.set({ channelRetryAt: null })
		.where(
			and(
				lte(dispatchOrders.channelRetryAt, now),
				isNull(dispatchOrders.channelSentAt),
			),
		)
		.returning({ dispatchId: dispatchOrders.dispatchId });
	const dispatchIds = [...new Set(claimed.map((c) => c.dispatchId))];
	let sent = 0;
	for (const dispatchId of dispatchIds) {
		try {
			if ((await sendTracking(db, dispatchId, outside)).sent) sent++;
		} catch (err) {
			// Voided or incomplete since: nothing left to send.
			console.error(`Tracking retry for dispatch ${dispatchId} stopped`, err);
		}
	}
	return { tried: dispatchIds.length, sent };
}

// How long the request that was refused keeps retrying after its response,
// inside Vercel's five-minute limit. Retries still due after that go out with
// the open orders page's next sync, or the four-hourly sweep.
const FOLLOW_UP_FOR_MS = 4.5 * 60_000;

// Keeps retrying a refused send from the request that sent it (under
// waitUntil), so nothing has to poll for due retries: waits for the
// dispatch's next retry, makes every retry that's due, and stops once none is
// waiting. Claims (above) keep it from trying a send twice alongside a sweep.
export async function followUpTracking(
	db: Db,
	dispatchId: number,
	outside: Outside = live,
	clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
		now: Date.now,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	},
) {
	const until = clock.now() + FOLLOW_UP_FOR_MS;
	for (;;) {
		const [next] = await db
			.select({ at: dispatchOrders.channelRetryAt })
			.from(dispatchOrders)
			.where(
				and(
					eq(dispatchOrders.dispatchId, dispatchId),
					isNull(dispatchOrders.channelSentAt),
					isNotNull(dispatchOrders.channelRetryAt),
				),
			)
			.orderBy(asc(dispatchOrders.channelRetryAt))
			.limit(1);
		if (!next?.at || next.at.getTime() > until) return;
		await clock.sleep(Math.max(0, next.at.getTime() - clock.now()));
		await retryDueTracking(db, new Date(clock.now()), outside);
	}
}

// Someone pressed Retry: a fresh ten minutes of retrying if this try is
// refused too.
export async function resendTrackingNow(
	db: Db,
	dispatchId: number,
	outside: Outside = live,
) {
	await db
		.update(dispatchOrders)
		.set({ channelFirstFailedAt: null, channelAttempts: 0 })
		.where(
			and(
				eq(dispatchOrders.dispatchId, dispatchId),
				isNull(dispatchOrders.channelSentAt),
			),
		);
	return sendTracking(db, dispatchId, outside);
}
