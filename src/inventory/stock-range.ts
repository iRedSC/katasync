import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { productSuppliers, products, settings, suppliers } from "#/db/schema";
import {
	DEFAULT_COVER_DAYS,
	loadPlan,
	type Plan,
	planFor,
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

// The lowest default max, so slow sellers still keep a few on the shelf.
export const MIN_FORECAST_MAX = 5;

// The max a forecast gives: what reorder tops stock up to (see
// stockTarget). At least MIN_FORECAST_MAX, and always above min.
export function forecastMax(
	min: number,
	p: {
		dailyDemand: number;
		leadTimeDays: number;
		safetyStock: number;
		coverDays: number;
	},
) {
	return Math.max(min + 1, MIN_FORECAST_MAX, stockTarget(p));
}

// Each product's default range, ignoring any range of its own. Pass `plan`
// when the caller already has one, to skip loading it twice.
export async function defaultRanges(
	db: Db,
	productIds: number[],
	plan?: Plan | Promise<Plan>,
): Promise<Map<number, StockRange>> {
	if (productIds.length === 0) return new Map();
	const [min, linked, planned] = await Promise.all([
		defaultMinStock(db),
		db
			.select({
				productId: productSuppliers.productId,
				supplierId: productSuppliers.supplierId,
				coverDays: suppliers.coverDays,
			})
			.from(productSuppliers)
			.innerJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
			.where(inArray(productSuppliers.productId, productIds)),
		plan ?? loadPlan(db),
	]);
	const supplier = new Map(linked.map((l) => [l.productId, l]));
	return new Map(
		productIds.map((id) => {
			const s = supplier.get(id);
			const max = forecastMax(min, {
				...planFor(planned, id, s?.supplierId ?? null),
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
	plan?: Plan | Promise<Plan>,
) {
	const [defaults, own] = await Promise.all([
		defaultRanges(db, productIds, plan),
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
