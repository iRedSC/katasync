import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations } from "#/db/schema";

// Locations whose stock is ours: the warehouse and the retail store, not
// Amazon's FBA. Counting, transfers, POs, buying, and what the channels sell
// all work across these. Only the warehouse (kind "owned" alone) ships
// orders, so shipping and ship-from still check for that.
export const ourKinds = ["owned", "retail"] as const;
export type OurKind = (typeof ourKinds)[number];

export const isOurs = inArray(locations.kind, [...ourKinds]);

export class PosLocationError extends Error {
	name = "PosLocationError";
}

// The shelf Shopify POS sales take stock from, or null when none is set.
export async function posLocation(db: Db): Promise<number | null> {
	const [row] = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.posPrimary, true));
	return row?.id ?? null;
}

// Makes one of our locations the one POS sales take from, from the next sale
// on. Sales already recorded stay where they took stock.
export async function setPosLocation(db: Db, locationId: number) {
	return db.transaction(async (tx) => {
		// Every location locked, so two changes at once take turns instead of
		// the second tripping the one-primary index.
		const all = await tx
			.select({ id: locations.id, name: locations.name, kind: locations.kind })
			.from(locations)
			.for("update");
		const target = all.find((l) => l.id === locationId);
		if (!target) throw new PosLocationError(`No location ${locationId}`);
		if (target.kind === "fba")
			throw new PosLocationError(
				`${target.name} is Amazon's; POS sales take from one of ours`,
			);
		if (!(ourKinds as readonly string[]).includes(target.kind))
			throw new PosLocationError(
				`${target.name} holds stock in transit; POS sales take from a shelf`,
			);
		// Cleared first: the one-primary index checks each row as it changes.
		await tx
			.update(locations)
			.set({ posPrimary: false })
			.where(eq(locations.posPrimary, true));
		await tx
			.update(locations)
			.set({ posPrimary: true })
			.where(and(eq(locations.id, locationId), isOurs));
		return { locationId, name: target.name };
	});
}

export const TRANSIT_LOCATION = "In transit";

export async function transitLocation(db: Db): Promise<number> {
	await db
		.insert(locations)
		.values({ name: TRANSIT_LOCATION, kind: "transit" })
		.onConflictDoNothing({ target: locations.name });
	const [row] = await db
		.select({ id: locations.id, kind: locations.kind })
		.from(locations)
		.where(eq(locations.name, TRANSIT_LOCATION));
	if (!row || row.kind !== "transit")
		throw new Error(
			`The location named "${TRANSIT_LOCATION}" isn't a transit location`,
		);
	return row.id;
}
