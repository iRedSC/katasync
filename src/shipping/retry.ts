import { and, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "#/db/client";
import { dispatchOrders } from "#/db/schema";
import { live, type Outside, sendTracking } from "./handoff";

// Sends again the tracking a marketplace refused, once each send's retry is
// due. Runs every minute (src/routes/api/cron/tracking.ts). Each due send is
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
