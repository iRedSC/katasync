import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, settings } from "#/db/schema";

// What the channels can sell from: the warehouse, then the retail store above
// what it keeps for walk-ins. The same rule shipped orders take stock by
// (recordSale with an overflow), so what's offered online is what an order
// can actually get.
export type OnlineStock = {
	locationIds: number[];
	keep: { locationId: number; units: number } | null;
};

export async function onlineStock(db: Db): Promise<OnlineStock> {
	const [warehouse, retail, reserve] = await Promise.all([
		db
			.select({ id: locations.id })
			.from(locations)
			.where(eq(locations.kind, "owned")),
		db
			.select({ id: locations.id })
			.from(locations)
			.where(eq(locations.kind, "retail")),
		retailReserve(db),
	]);
	// Orders overflow only to a single retail store (stockLocations), so
	// several would be offered online but never taken.
	const store = retail.length === 1 ? retail[0].id : null;
	return {
		locationIds: [
			...warehouse.map((l) => l.id),
			...(store === null ? [] : [store]),
		],
		keep: store === null ? null : { locationId: store, units: reserve },
	};
}

export class ReserveError extends Error {
	name = "ReserveError";
}

// Units the retail store keeps for walk-ins; overflow takes only what's
// above it.
export async function retailReserve(db: Db): Promise<number> {
	const [row] = await db
		.select({ units: settings.retailReserve })
		.from(settings);
	// The migration makes the row; without it something is badly wrong.
	if (!row) throw new Error("The settings row is missing");
	return row.units;
}

export async function setRetailReserve(db: Db, units: number) {
	if (!Number.isInteger(units) || units < 0)
		throw new ReserveError("The reserve is a whole number from 0");
	await db.update(settings).set({ retailReserve: units });
}
