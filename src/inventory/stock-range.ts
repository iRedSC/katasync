import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { products, settings } from "#/db/schema";

// How much of a product we like to keep on our own shelves: at least min,
// at most max. A product without its own range uses the defaults in settings.
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

export async function stockDefaults(db: Db): Promise<StockRange> {
	const [row] = await db
		.select({ min: settings.defaultMinStock, max: settings.defaultMaxStock })
		.from(settings);
	// The migration makes the row; without it something is badly wrong.
	if (!row) throw new Error("The settings row is missing");
	return row;
}

export async function setStockDefaults(db: Db, range: StockRange) {
	checkRange(range);
	await db
		.update(settings)
		.set({ defaultMinStock: range.min, defaultMaxStock: range.max });
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

// Each product's range, its own or the defaults.
export async function stockRanges(db: Db, productIds: number[]) {
	const [defaults, own] = await Promise.all([
		stockDefaults(db),
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
	for (const p of own)
		ranges.set(
			p.id,
			p.min !== null && p.max !== null
				? { min: p.min, max: p.max, own: true }
				: { ...defaults, own: false },
		);
	return ranges;
}
