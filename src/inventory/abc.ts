import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLines,
	orders,
	productComponents,
	productSuppliers,
	products,
} from "#/db/schema";
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
	// Tool sets, ranked among themselves by their own sales (units of the set
	// times what its parts cost), so an expensive set ranks high on few
	// orders. Kept apart from classes: those already count set sales through
	// the parts, and ranking both together would count them twice. Sets with
	// a part that has no cost are left out, like unpriced products.
	sets: Map<number, AbcRank>;
	unpriced: number;
	// Days of sales behind the classes: ABC_DAYS, or less while order history
	// is younger than that.
	days: number;
};

// Classes for every stocked product. Computed fresh, like reorder suggestions,
// so it never goes stale.
export async function abcClasses(db: Db, now = new Date()): Promise<AbcResult> {
	const since = new Date(now.getTime() - ABC_DAYS * 86_400_000);
	const [sold, stocked, [first], setSales, setCosts] = await Promise.all([
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
		// Sets sold as sets, counted the way soldSince counts with FBA.
		db
			.select({
				productId: orderLines.productId,
				units: sql<number>`sum(${orderLines.quantity})::int`,
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.innerJoin(products, eq(products.id, orderLines.productId))
			.where(
				and(
					eq(products.kind, "bundle"),
					gte(orders.placedAt, since),
					isNull(orders.cancelledAt),
				),
			)
			.groupBy(orderLines.productId),
		// What a set's parts cost, null when any part has no cost.
		db
			.select({
				setId: productComponents.parentProductId,
				cost: sql<
					number | null
				>`case when bool_or(coalesce(${productSuppliers.cost}, ${products.unitCost}) is null) then null else sum(${productComponents.quantity} * coalesce(${productSuppliers.cost}, ${products.unitCost})) end::float8`,
			})
			.from(productComponents)
			.innerJoin(
				products,
				eq(products.id, productComponents.componentProductId),
			)
			.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
			.groupBy(productComponents.parentProductId),
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

	const setUnits = new Map(setSales.map((r) => [r.productId, r.units]));
	const setRows: typeof rows = [];
	for (const { setId, cost } of setCosts) {
		const units = setUnits.get(setId) ?? 0;
		if (units > 0 && cost === null) {
			unpriced++;
			continue;
		}
		setRows.push({ productId: setId, units, value: units * (cost ?? 0) });
	}

	const firstOrder = first?.at ? new Date(first.at) : null;
	const history = firstOrder
		? Math.ceil((now.getTime() - firstOrder.getTime()) / 86_400_000)
		: 0;
	return {
		classes: classify(rows),
		sets: classify(setRows),
		unpriced,
		days: Math.max(0, Math.min(ABC_DAYS, history)),
	};
}
