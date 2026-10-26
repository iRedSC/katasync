import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { returnRequests, returnTracking } from "#/db/schema";
import {
	guessCarrier,
	normalTracking,
} from "#/purchasing/inbox/tracking-numbers";
import {
	askShippo,
	type Carrier,
	CONCURRENCY,
	eachLimit,
} from "#/purchasing/tracking";
import { carrierPage, TERMINAL } from "./tracking-read";

// A return's package, followed on Shippo as a PO's are: asked when its
// order is opened, then every four hours with the sync crons until it
// arrives or goes back, the request closes, or staff stop following it.
// Only evidence: nothing here receives a return. Server only.

type Request = {
	id: number;
	carrier: string | null;
	trackingNumber: string | null;
};
type Saved = typeof returnTracking.$inferSelect;
// Enough to say where a package is, for a list of them.
export type PackageAt = Pick<Saved, "status" | "statusAt" | "eta">;

// Marketplaces name the carrier loosely ("UPS Ground", "USPS"), so its name
// is read for one of Shippo's carriers, and the number's shape decides when
// it names none.
export function returnCarrier(
	carrier: string | null,
	number: string,
): Carrier | null {
	const c = carrier?.toLowerCase() ?? "";
	if (c.includes("usps") || c.includes("postal")) return "usps";
	if (c.includes("fedex")) return "fedex";
	if (c.includes("ups")) return "ups";
	return guessCarrier(number);
}

// The carrier's own page for a request's package; null with no number or
// a carrier we can't name.
export function returnTrackingPage(
	carrier: string | null,
	trackingNumber: string | null,
) {
	if (!trackingNumber) return null;
	const number = normalTracking(trackingNumber);
	const c = returnCarrier(carrier, number);
	return c ? carrierPage({ carrier: c, number }) : null;
}

// What's saved for a request, when it's for the number the request has
// now. One saved for a number the marketplace has since changed says
// nothing about the package coming.
export function trackingFor<T extends { number: string }>(
	trackingNumber: string | null,
	saved: T | null,
): T | null {
	return saved &&
		trackingNumber &&
		saved.number === normalTracking(trackingNumber)
		? saved
		: null;
}

// What asking about a request's package came to.
export type ReturnFollow =
	| { state: "checked"; saved: Saved }
	// No number, or a carrier Shippo doesn't follow: nothing to ask.
	| { state: "unsupported" }
	| { state: "failed"; why: string };

// Asks Shippo about a request's package and keeps the answer. A failure is
// returned, never thrown, so one bad number doesn't stop the rest.
export async function followReturn(db: Db, r: Request): Promise<ReturnFollow> {
	if (!r.trackingNumber) return { state: "unsupported" };
	const number = normalTracking(r.trackingNumber);
	const carrier = returnCarrier(r.carrier, number);
	if (!carrier || !/^[0-9A-Z]{8,40}$/.test(number))
		return { state: "unsupported" };
	let now: Awaited<ReturnType<typeof askShippo>>;
	try {
		now = await askShippo(carrier, number);
	} catch (error) {
		return {
			state: "failed",
			why: error instanceof Error ? error.message : String(error),
		};
	}
	const row = { ...now, carrier, number, checkedAt: new Date() };
	const [saved] = await db
		.insert(returnTracking)
		.values({ returnRequestId: r.id, ...row })
		.onConflictDoUpdate({ target: returnTracking.returnRequestId, set: row })
		.returning();
	if (!saved) throw new Error(`No return request ${r.id}`);
	return { state: "checked", saved };
}

// Whether the sweep asks about a request's package again: not once it got
// there or went back, nor when it has no number to ask about. However long
// it takes otherwise, it's followed until the request closes or staff stop
// following it, which the sweep's query leaves out.
export const sweepDue = (r: {
	trackingNumber: string | null;
	saved: { number: string; status: Saved["status"] } | null;
}) => {
	if (!r.trackingNumber) return false;
	const saved = trackingFor(r.trackingNumber, r.saved);
	return !saved || !TERMINAL.includes(saved.status);
};

// Asks Shippo again about every open return's package that hasn't arrived,
// and any whose number changed or was never asked about. Run every four
// hours by the tracking cron. Says how many were checked, how many have a
// carrier Shippo doesn't follow, which failed and why, and how many open
// requests were skipped as arrived or without a number.
export async function refreshReturnTracking(db: Db) {
	const open = await db
		.select({
			id: returnRequests.id,
			carrier: returnRequests.carrier,
			trackingNumber: returnRequests.trackingNumber,
			saved: { number: returnTracking.number, status: returnTracking.status },
		})
		.from(returnRequests)
		.leftJoin(
			returnTracking,
			eq(returnTracking.returnRequestId, returnRequests.id),
		)
		.where(
			and(
				notInArray(returnRequests.status, ["closed", "cancelled"]),
				isNull(returnRequests.unfollowedAt),
			),
		);
	const due = open.filter(sweepDue);
	const asked = await eachLimit(due, CONCURRENCY, async (r) => ({
		number: r.trackingNumber,
		follow: await followReturn(db, r),
	}));
	return {
		checked: asked.filter((a) => a.follow.state === "checked").length,
		unsupported: asked.filter((a) => a.follow.state === "unsupported").length,
		failed: asked.flatMap((a) =>
			a.follow.state === "failed" ? [`${a.number}: ${a.follow.why}`] : [],
		),
		skipped: open.length - due.length,
	};
}
