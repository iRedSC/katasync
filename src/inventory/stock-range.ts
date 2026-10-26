import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { products, settings, supplierOffers, suppliers } from "#/db/schema";
import { NO_FORECAST, recentSales } from "#/purchasing/forecast";
import {
	DEFAULT_COVER_DAYS,
	forecastMax,
	loadPlan,
	type Plan,
} from "#/purchasing/reorder";

export { forecastMax } from "#/purchasing/reorder";

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
			// Each product's cheapest supplier, the one reorder buys from.
			.select({
				productId: supplierOffers.productId,
				coverDays: suppliers.coverDays,
			})
			.from(supplierOffers)
			.innerJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
			.where(
				and(
					inArray(supplierOffers.productId, productIds),
					eq(supplierOffers.cheapest, true),
				),
			),
		plan ?? loadPlan(db),
	]);
	const supplier = new Map(linked.map((l) => [l.productId, l]));
	return new Map(
		productIds.map((id) => {
			const s = supplier.get(id);
			const { sold } = recentSales(
				planned.forecasts.get(id) ?? NO_FORECAST,
				s?.coverDays ?? DEFAULT_COVER_DAYS,
			);
			const max = forecastMax(min, sold);
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
