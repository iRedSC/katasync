import { eq, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders, productSuppliers, products } from "#/db/schema";
import { soldSince } from "#/inventory/sales";

// ABC analysis: which stocked products carry the most money. Value is units
// sold over ABC_DAYS times unit cost, so tool sets count through their parts
// and nobody has to split a set's price between them.
export type AbcClass = "A" | "B" | "C";

export const ABC_DAYS = 365;
// A is the products making up the first 80% of value, B the next 15%, C the
// rest and anything unsold.
const A_SHARE = 0.8;
const B_SHARE = 0.95;

// How often each class's shelves get counted.
export const COUNT_EVERY_DAYS: Record<AbcClass, number> = {
	A: 30,
	B: 90,
	C: 365,
};

export type AbcRank = {
	abc: AbcClass;
	// 1 is the most value.
	rank: number;
	// This product's part of all value, 0 to 1.
	share: number;
	value: number;
	units: number;
};

// Ranks by value, highest first. The product that crosses a cutoff takes the
// higher class, so A is never empty while anything sold.
export function classify(
	rows: { productId: number; value: number; units: number }[],
): Map<number, AbcRank> {
	const sorted = [...rows].sort(
		(a, b) => b.value - a.value || a.productId - b.productId,
	);
	const total = sorted.reduce((sum, r) => sum + r.value, 0);
	const result = new Map<number, AbcRank>();
	let before = 0;
	sorted.forEach((r, i) => {
		const abc: AbcClass =
			r.value <= 0 || total <= 0
				? "C"
				: before < total * A_SHARE
					? "A"
					: before < total * B_SHARE
						? "B"
						: "C";
		result.set(r.productId, {
			abc,
			rank: i + 1,
			share: total > 0 ? r.value / total : 0,
			value: r.value,
			units: r.units,
		});
		before += r.value;
	});
	return result;
}

export type AbcResult = {
	// Products that sold but have no cost are left out: they can't be valued,
	// and calling them C would hide them.
	classes: Map<number, AbcRank>;
	unpriced: number;
	// Days of sales behind the classes: ABC_DAYS, or less while order history
	// is younger than that.
	days: number;
};

// Classes for every stocked product. Computed fresh, like reorder suggestions,
// so it never goes stale.
export async function abcClasses(db: Db, now = new Date()): Promise<AbcResult> {
	const since = new Date(now.getTime() - ABC_DAYS * 86_400_000);
	const [sold, stocked, [first]] = await Promise.all([
		soldSince(db, since, { includeFba: true }),
		db
			.select({
				id: products.id,
				// The supplier's price if we know it, else what we last valued it at.
				cost: sql<
					number | null
				>`coalesce(${productSuppliers.cost}, ${products.unitCost})::float8`,
			})
			.from(products)
			.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
			.where(ne(products.kind, "bundle")),
		db.select({ at: sql<string | null>`min(${orders.placedAt})` }).from(orders),
	]);

	let unpriced = 0;
	const rows: { productId: number; value: number; units: number }[] = [];
	for (const p of stocked) {
		const units = sold.get(p.id) ?? 0;
		if (units > 0 && p.cost === null) {
			unpriced++;
			continue;
		}
		rows.push({ productId: p.id, units, value: units * (p.cost ?? 0) });
	}

	const firstOrder = first?.at ? new Date(first.at) : null;
	const history = firstOrder
		? Math.ceil((now.getTime() - firstOrder.getTime()) / 86_400_000)
		: 0;
	return {
		classes: classify(rows),
		unpriced,
		days: Math.max(0, Math.min(ABC_DAYS, history)),
	};
}

// A shelf is due once its class's interval has passed since the last count,
// or right away if it was never counted. Unclassed products count yearly.
export function isCountDue(
	abc: AbcClass | null,
	lastCountedAt: Date | null,
	now: Date,
): boolean {
	if (lastCountedAt === null) return true;
	const every = COUNT_EVERY_DAYS[abc ?? "C"] * 86_400_000;
	return now.getTime() - lastCountedAt.getTime() >= every;
}
