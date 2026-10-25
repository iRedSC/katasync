import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { packageTracking } from "#/db/schema";
import {
	type Carrier,
	normalTracking,
} from "#/purchasing/inbox/tracking-numbers";
import { askShippo } from "#/purchasing/tracking";
import { afterFailure, type TrackingRead } from "./tracking-read";

// Where a package sent to a buyer is, asked of Shippo each time it's looked
// at. Each answer is kept, so when Shippo can't be asked the last scans
// still show, marked stale. Server only.

export async function readTracking(
	db: Db,
	carrier: Carrier,
	number: string,
): Promise<TrackingRead> {
	const n = normalTracking(number);
	const [kept] = await db
		.select()
		.from(packageTracking)
		.where(
			and(eq(packageTracking.carrier, carrier), eq(packageTracking.number, n)),
		);
	let now: Awaited<ReturnType<typeof askShippo>>;
	try {
		now = await askShippo(carrier, n);
	} catch (error) {
		return afterFailure(kept ?? null, error);
	}
	const row = { ...now, carrier, number: n, checkedAt: new Date() };
	await db
		.insert(packageTracking)
		.values(row)
		.onConflictDoUpdate({
			target: [packageTracking.carrier, packageTracking.number],
			set: row,
		});
	return { state: "fresh", t: row };
}
