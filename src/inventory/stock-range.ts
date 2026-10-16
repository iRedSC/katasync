import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { productSuppliers, products, settings, suppliers } from "#/db/schema";
import { type AbcResult, abcClasses } from "#/inventory/abc";
import { soldSince } from "#/inventory/sales";
import {
	DEFAULT_COVER_DAYS,
	DEFAULT_LEAD_TIME_DAYS,
	DEMAND_DAYS,
	safetyDays,
	stockTarget,
} from "#/purchasing/reorder";

// How much of a product we like to keep on our own shelves: at least min,
// at most max. A product without its own range gets a default one: min from
// settings, max from its forecast (see defaultRanges).
export type StockRange = { min: number; max: number };

export class StockRangeError extends Error {}

// Whole numbers, min from 0, max above min. The database checks the same.
export function checkRange(range: StockRange) {
	const { min, max } = range;
	if (!Number.isInteger(min) || !Number.isInteger(max))
		throw new StockRangeError("Min and max are whole numbers");
	if (min < 0) throw new StockRangeError("Min can't be below 0");
	if (max <= min) throw new StockRangeError("Max has to be more than min");
}

// The default min. Max has no setting: it comes from each product's sales.
export async function defaultMinStock(db: Db): Promise<number> {
	const [row] = await db
		.select({ min: settings.defaultMinStock })
		.from(settings);
	// The migration makes the row; without it something is badly wrong.
	if (!row) throw new Error("The settings row is missing");
	return row.min;
}

export async function setDefaultMinStock(db: Db, min: number) {
	if (!Number.isInteger(min) || min < 0)
		throw new StockRangeError("Min is a whole number from 0");
	await db.update(settings).set({ defaultMinStock: min });
}

// null puts the product back on the defaults.
export async function setProductStockRange(
	db: Db,
	productId: number,
	range: StockRange | null,
) {
	if (range) checkRange(range);
	await db
		.update(products)
		.set({ minStock: range?.min ?? null, maxStock: range?.max ?? null })
		.where(eq(products.id, productId));
}

// The max a forecast gives: what reorder tops stock up to, from the last
// DEMAND_DAYS of sales, the supplier's lead time and cover (the suppliers
// defaults without one), and A items' safety stock. Always above min, so a
// product that doesn't sell still has a range.
export function forecastMax(
	min: number,
	p: {
		dailyDemand: number;
		leadTimeDays: number;
		safetyDays: number;
		coverDays: number;
	},
) {
	return Math.max(min + 1, stockTarget(p));
}

// Each product's default range, ignoring any range of its own. Pass `abc`
// when the caller already has it, to skip ranking twice.
export async function defaultRanges(
	db: Db,
	productIds: number[],
	abc?: AbcResult,
): Promise<Map<number, StockRange>> {
	if (productIds.length === 0) return new Map();
	const since = new Date(Date.now() - DEMAND_DAYS * 86_400_000);
	const [min, sold, linked, classes] = await Promise.all([
		defaultMinStock(db),
		soldSince(db, since, { includeFba: false }),
		db
			.select({
				productId: productSuppliers.productId,
				leadTimeDays: suppliers.leadTimeDays,
				coverDays: suppliers.coverDays,
			})
			.from(productSuppliers)
			.innerJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
			.where(inArray(productSuppliers.productId, productIds)),
		abc ?? abcClasses(db),
	]);
	const supplier = new Map(linked.map((l) => [l.productId, l]));
	return new Map(
		productIds.map((id) => {
			const s = supplier.get(id);
			const leadTimeDays = s?.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
			const max = forecastMax(min, {
				dailyDemand: (sold.get(id) ?? 0) / DEMAND_DAYS,
				leadTimeDays,
				safetyDays: safetyDays(
					classes.classes.get(id)?.abc ?? null,
					leadTimeDays,
				),
				coverDays: s?.coverDays ?? DEFAULT_COVER_DAYS,
			});
			return [id, { min, max }];
		}),
	);
}

// Each product's range: its own, or the default.
export async function stockRanges(
	db: Db,
	productIds: number[],
	abc?: AbcResult,
) {
	const [defaults, own] = await Promise.all([
		defaultRanges(db, productIds, abc),
		productIds.length === 0
			? []
			: db
					.select({
						id: products.id,
						min: products.minStock,
						max: products.maxStock,
					})
					.from(products)
					.where(inArray(products.id, productIds)),
	]);
	const ranges = new Map<number, StockRange & { own: boolean }>();
	for (const p of own) {
		const fallback = defaults.get(p.id);
		if (p.min !== null && p.max !== null)
			ranges.set(p.id, { min: p.min, max: p.max, own: true });
		else if (fallback) ranges.set(p.id, { ...fallback, own: false });
	}
	return ranges;
}
