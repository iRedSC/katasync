import type { Db } from "#/db/client";
import { settings } from "#/db/schema";

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
