import { and, inArray } from "drizzle-orm";
import { saleLocation, stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import { stockLevels } from "#/db/schema";
import type { MovementLine } from "#/inventory/ledger";

export class ConsumeError extends Error {
	name = "ConsumeError";
}

export type Shelves = {
	main: number;
	overflow: { locationId: number; keep: number } | null;
};

export function allocate(
	shelves: Shelves,
	units: { productId: number; quantity: number }[],
	holds: Map<string, number>,
): MovementLine[] {
	const key = (productId: number, locationId: number) =>
		`${productId}:${locationId}`;
	const at = (productId: number, locationId: number) =>
		Math.max(0, holds.get(key(productId, locationId)) ?? 0);
	return units.flatMap((u) => {
		const first = Math.min(u.quantity, at(u.productId, shelves.main));
		const spare = shelves.overflow
			? Math.max(
					0,
					at(u.productId, shelves.overflow.locationId) - shelves.overflow.keep,
				)
			: 0;
		const spill = Math.min(u.quantity - first, spare);
		const main = u.quantity - spill;
		const lines: MovementLine[] = [];
		if (main > 0) {
			lines.push({
				productId: u.productId,
				locationId: shelves.main,
				delta: -main,
				reason: "sale",
			});
			holds.set(
				key(u.productId, shelves.main),
				(holds.get(key(u.productId, shelves.main)) ?? 0) - main,
			);
		}
		if (spill > 0 && shelves.overflow) {
			const id = shelves.overflow.locationId;
			lines.push({
				productId: u.productId,
				locationId: id,
				delta: -spill,
				reason: "sale",
			});
			holds.set(key(u.productId, id), at(u.productId, id) - spill);
		}
		return lines;
	});
}

// The shelves a shipped order takes stock from: the warehouse, then the
// retail store above what it keeps. Online stock offers exactly these.
export async function shipsFrom(
	db: Db,
): Promise<Shelves | { problem: string }> {
	const shelf = saleLocation(await stockLocations(db), { soldInStore: false });
	if ("problem" in shelf) return shelf;
	return {
		main: shelf.locationId,
		overflow:
			shelf.overflow && shelf.overflow.locationId !== shelf.locationId
				? shelf.overflow
				: null,
	};
}

export async function shippingShelves(db: Db): Promise<Shelves> {
	const shelves = await shipsFrom(db);
	if ("problem" in shelves) throw new ConsumeError(shelves.problem);
	return shelves;
}

export async function lockedHolds(
	db: Db,
	productIds: number[],
	shelves: Shelves,
) {
	const locationIds = [
		shelves.main,
		...(shelves.overflow ? [shelves.overflow.locationId] : []),
	];
	const rows =
		productIds.length === 0
			? []
			: await db
					.select()
					.from(stockLevels)
					.where(
						and(
							inArray(stockLevels.productId, productIds),
							inArray(stockLevels.locationId, locationIds),
						),
					)
					.orderBy(stockLevels.productId, stockLevels.locationId)
					.for("update");
	return new Map(rows.map((r) => [`${r.productId}:${r.locationId}`, r.onHand]));
}
