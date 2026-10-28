import type { Db } from "#/db/client";
import { shipsFrom } from "./commitments-shelves";

// What the channels can sell from: exactly the shelves a shipped order takes
// stock from (shipsFrom), the warehouse and then the retail store above what
// it keeps for walk-ins, so what's offered online is what an order can
// actually get. When orders can't tell where to ship from (no warehouse, or
// several), nothing is offered, since no order could take it.
export type OnlineStock = {
	locationIds: number[];
	keep: { locationId: number; units: number } | null;
};

export async function onlineStock(db: Db): Promise<OnlineStock> {
	const shelves = await shipsFrom(db);
	if ("problem" in shelves) return { locationIds: [], keep: null };
	const { main, overflow } = shelves;
	return {
		locationIds: overflow ? [main, overflow.locationId] : [main],
		keep: overflow && { locationId: overflow.locationId, units: overflow.keep },
	};
}
