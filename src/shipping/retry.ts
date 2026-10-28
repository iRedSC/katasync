import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "#/db/client";
import { dispatchOrders } from "#/db/schema";
import { live, type Outside, sendTracking } from "./handoff";
import { RETRY_FOR_MS } from "./retry-window";

// A run holds what it's trying for this long: Vercel ends a run at five
// minutes, so by then whoever leased it is gone and it's due again.
export const LEASE_MS = 5 * 60_000;
// Dispatches leased at once, few enough to try well inside one lease.
const BATCH = 10;

// Sends again the tracking a marketplace refused, once each send's retry is
// due. Run by followUpTracking, the orders page's sync and a four-hourly
// sweep (src/routes/api/cron/tracking.ts). Each due send is leased before
// it's tried, so two runs never try the same one, and one that dies midway
// leaves it due again when the lease ends. A refusal sets its next try (see
// tell in handoff.ts), or none once ten minutes have passed, which leaves it
// on Diagnostics with a retry button.
export async function retryDueTracking(
	db: Db,
	now = new Date(),
	outside: Outside = live,
) {
	let tried = 0;
	let sent = 0;
	for (;;) {
		const leased = await lease(db, now);
		if (leased.length === 0) return { tried, sent };
		for (const { dispatchId, firstFailedAt, token } of leased) {
			tried++;
			try {
				if ((await sendTracking(db, dispatchId, outside)).sent) sent++;
			} catch (err) {
				console.error(`Tracking retry for dispatch ${dispatchId} stopped`, err);
				// Voided or incomplete since, or katasync itself failed: tried
				// again when the lease ends, until the ten minutes are over.
				const over =
					!firstFailedAt ||
					now.getTime() >= firstFailedAt.getTime() + RETRY_FOR_MS;
				if (!over) continue;
			}
			// No outcome recorded (cancelled, refunded, test label, or gave up
			// above): nothing more to try.
			await db
				.update(dispatchOrders)
				.set({ channelRetryAt: null, channelRetryLease: null })
				.where(
					and(
						eq(dispatchOrders.dispatchId, dispatchId),
						eq(dispatchOrders.channelRetryLease, token),
					),
				);
		}
	}
}

type Leased = { dispatchId: number; firstFailedAt: Date | null; token: string };

// Leases a batch of due dispatches: their retry moves to the lease's end
// under a fresh token. A row another run leased first is no longer due, so
// it's never leased twice.
async function lease(db: Db, now: Date): Promise<Leased[]> {
	const due = and(
		lte(dispatchOrders.channelRetryAt, now),
		isNull(dispatchOrders.channelSentAt),
	);
	const token = crypto.randomUUID();
	const rows = await db
		.update(dispatchOrders)
		.set({
			channelRetryAt: new Date(now.getTime() + LEASE_MS),
			channelRetryLease: token,
		})
		.where(
			and(
				due,
				inArray(
					dispatchOrders.dispatchId,
					db
						.selectDistinct({ dispatchId: dispatchOrders.dispatchId })
						.from(dispatchOrders)
						.where(due)
						.orderBy(dispatchOrders.dispatchId)
						.limit(BATCH),
				),
			),
		)
		.returning({
			dispatchId: dispatchOrders.dispatchId,
			firstFailedAt: dispatchOrders.channelFirstFailedAt,
		});
	// One entry per dispatch, with its orders' earliest first refusal.
	const byDispatch = new Map<number, Leased>();
	for (const { dispatchId, firstFailedAt } of rows) {
		const seen = byDispatch.get(dispatchId)?.firstFailedAt;
		byDispatch.set(dispatchId, {
			dispatchId,
			firstFailedAt:
				seen && (!firstFailedAt || seen < firstFailedAt) ? seen : firstFailedAt,
			token,
		});
	}
	return [...byDispatch.values()];
}

// How long the request that was refused keeps retrying after its response,
// inside Vercel's five-minute limit. Retries still due after that go out with
// the open orders page's next sync, or the four-hourly sweep.
const FOLLOW_UP_FOR_MS = 4.5 * 60_000;

// Keeps retrying a refused send from the request that sent it (under
// waitUntil), so nothing has to poll for due retries: waits for the
// dispatch's next retry, makes every retry that's due, and stops once none is
// waiting. Leases (above) keep it from trying a send twice alongside a sweep.
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
