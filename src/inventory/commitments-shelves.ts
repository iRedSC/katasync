import { and, inArray } from "drizzle-orm";
import { saleLocation, stockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import { stockLevels } from "#/db/schema";
import type { MovementLine } from "#/inventory/ledger";
import { committedUnits, type QuantityMode } from "./commitments";

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

// Products a withdrawal would leave short of what's promised to orders: in
// committed mode, those whose shipping shelves (shipsFrom, the store only
// above its reserve) would end up holding fewer than their committed units,
// and fewer than before. Taking from a shelf shipping doesn't use breaks no
// promise. Takes the mode so callers read it before locking products, as
// everywhere else that touches commitments.
export async function brokenPromises(
	db: Db,
	mode: QuantityMode,
	withdrawals: { productId: number; locationId: number; quantity: number }[],
): Promise<number[]> {
	if (mode === "legacy" || withdrawals.length === 0) return [];
	const shelves = await shipsFrom(db);
	if ("problem" in shelves) return [];
	const ids = [...new Set(withdrawals.map((w) => w.productId))];
	const before = await lockedHolds(db, ids, shelves);
	const after = new Map(before);
	const { main, overflow } = shelves;
	for (const w of withdrawals) {
		if (w.locationId !== main && w.locationId !== overflow?.locationId)
			continue;
		const key = `${w.productId}:${w.locationId}`;
		after.set(key, (after.get(key) ?? 0) - w.quantity);
	}
	const pool = (holds: Map<string, number>, id: number) =>
		Math.max(0, holds.get(`${id}:${main}`) ?? 0) +
		(overflow
			? Math.max(
					0,
					(holds.get(`${id}:${overflow.locationId}`) ?? 0) - overflow.keep,
				)
			: 0);
	const committed = await committedUnits(db, ids);
	return ids.filter((id) => {
		const left = pool(after, id);
		return left < pool(before, id) && left < (committed.get(id) ?? 0);
	});
}
