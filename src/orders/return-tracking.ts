import { and, eq, gte, notInArray } from "drizzle-orm";
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

// A return's package, followed on Shippo as a PO's are: asked when its
// order is first opened, then every four hours with the sync crons until
// it arrives. Only evidence: nothing here receives a return. Server only.

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

// Asks Shippo about a request's package and keeps the answer. Null when it
// has no number, or a carrier Shippo doesn't follow. Throws when Shippo
// can't be asked.
export async function followReturn(db: Db, r: Request): Promise<Saved | null> {
	if (!r.trackingNumber) return null;
	const number = normalTracking(r.trackingNumber);
	const carrier = returnCarrier(r.carrier, number);
	if (!carrier || !/^[0-9A-Z]{8,40}$/.test(number)) return null;
	const now = await askShippo(carrier, number);
	const row = { ...now, carrier, number, checkedAt: new Date() };
	const [saved] = await db
		.insert(returnTracking)
		.values({ returnRequestId: r.id, ...row })
		.onConflictDoUpdate({ target: returnTracking.returnRequestId, set: row })
		.returning();
	return saved ?? null;
}

const DONE = ["DELIVERED", "RETURNED"];
// Returns still not back after this long are left alone.
const GIVE_UP_MS = 60 * 86_400_000;

// Asks Shippo again about every open return's package that hasn't arrived,
// and any whose number changed or was never asked about. Run every four
// hours by the tracking cron.
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
				gte(returnRequests.requestedAt, new Date(Date.now() - GIVE_UP_MS)),
			),
		);
	const due = open.filter((r) => {
		if (!r.trackingNumber) return false;
		const saved = trackingFor(r.trackingNumber, r.saved);
		return !saved || !DONE.includes(saved.status);
	});
	const problems = (
		await eachLimit(due, CONCURRENCY, async (r) => {
			try {
				await followReturn(db, r);
				return null;
			} catch (error) {
				return `${r.trackingNumber}: ${error instanceof Error ? error.message : String(error)}`;
			}
		})
	).filter((p): p is string => p !== null);
	return { checked: due.length, problems };
}
