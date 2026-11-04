import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { getDb } from "#/db/client";
import { returnRequests, returnTracking } from "#/db/schema";
import { followReturn, trackingFor } from "#/orders/return-tracking";
import { afterFailure, type TrackingRead } from "#/orders/tracking-read";

// Following a return's package from the order page.

// Asks Shippo where a return request's package is and keeps the answer,
// as its order opens, between the four-hourly sweeps.
export const followReturnNow = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }): Promise<TrackingRead> => {
		const db = getDb();
		const [r] = await db
			.select({
				id: returnRequests.id,
				carrier: returnRequests.carrier,
				trackingNumber: returnRequests.trackingNumber,
				saved: returnTracking,
			})
			.from(returnRequests)
			.leftJoin(
				returnTracking,
				eq(returnTracking.returnRequestId, returnRequests.id),
			)
			.where(eq(returnRequests.id, data.id));
		if (!r) throw new Error(`No return request ${data.id}`);
		const follow = await followReturn(db, r);
		const strip = ({
			returnRequestId: _,
			...t
		}: typeof returnTracking.$inferSelect) => t;
		if (follow.state === "checked")
			return { state: "fresh", t: strip(follow.saved) };
		if (follow.state === "unsupported") return { state: "unsupported" };
		const kept = trackingFor(r.trackingNumber, r.saved);
		return afterFailure(kept && strip(kept), new Error(follow.why));
	});

// Stops, or starts again, following a return's package: one coming back
// some other way, or never coming, isn't asked about every four hours.
export const setReturnFollowed = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", followed: "boolean" }))
	.handler(async ({ data }) => {
		await getDb()
			.update(returnRequests)
			.set({ unfollowedAt: data.followed ? null : new Date() })
			.where(eq(returnRequests.id, data.id));
	});
