import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, products, stockLevels } from "#/db/schema";
import { committedUnits, readQuantityMode } from "./commitments";
import { onlineStock } from "./online-stock";

export type StockPosition =
	| { mode: "legacy"; productId: number; net: number; inTransit: number }
	| {
			mode: "committed";
			productId: number;
			physical: number;
			committed: number;
			available: number;
			shortage: number;
			inTransit: number;
	  };

export async function stockPositions(
	db: Db,
	productIds: number[],
): Promise<Map<number, StockPosition>> {
	const result = new Map<number, StockPosition>();
	if (productIds.length === 0) return result;
	const stocked = await db
		.select({ id: products.id })
		.from(products)
		.where(and(inArray(products.id, productIds), ne(products.kind, "bundle")));
	const ids = stocked.map((p) => p.id);
	if (ids.length === 0) return result;
	const [mode, from, committed, rows] = await Promise.all([
		readQuantityMode(db, "none"),
		onlineStock(db),
		committedUnits(db, ids),
		db
			.select({
				productId: stockLevels.productId,
				locationId: stockLevels.locationId,
				kind: locations.kind,
				onHand: stockLevels.onHand,
			})
			.from(stockLevels)
			.innerJoin(locations, eq(locations.id, stockLevels.locationId))
			.where(inArray(stockLevels.productId, ids)),
	]);
	for (const id of ids) {
		const shelves = rows.filter((r) => r.productId === id);
		const ours = shelves.filter((r) => r.kind === "owned" || r.kind === "retail");
		const physical = ours.reduce((n, r) => n + r.onHand, 0);
		const inTransit = shelves
			.filter((r) => r.kind === "transit")
			.reduce((n, r) => n + r.onHand, 0);
		if (mode === "legacy") {
			result.set(id, { mode, productId: id, net: physical, inTransit });
			continue;
		}
		const keep = from.keep;
		const main = ours
			.filter(
				(r) =>
					from.locationIds.includes(r.locationId) &&
					r.locationId !== keep?.locationId,
			)
			.reduce((n, r) => n + r.onHand, 0);
		const spare = keep
			? Math.max(
					0,
					(ours.find((r) => r.locationId === keep.locationId)?.onHand ?? 0) -
						keep.units,
				)
			: 0;
		const sellable = Math.max(0, main) + spare;
		const held = committed.get(id) ?? 0;
		result.set(id, {
			mode,
			productId: id,
			physical,
			committed: held,
			available: Math.max(0, sellable - held),
			shortage: Math.max(0, held - sellable),
			inTransit,
		});
	}
	return result;
}
