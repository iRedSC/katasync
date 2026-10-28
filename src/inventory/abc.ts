import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLines,
	orders,
	productComponents,
	products,
	supplierOffers,
} from "#/db/schema";
import { soldByLine } from "#/inventory/sales";
import { carried } from "#/products/archive";

// ABC analysis: which products earn the most. Value is margin over ABC_DAYS:
// what they sold for less what they cost. A stockout costs the sale, so the
// products that earn most are the ones worth protecting. A tool set's sale
// earns for its parts too: its price is split between them by their share of
// its cost.
export type AbcClass = "A" | "B" | "C";

export const ABC_DAYS = 365;
// A is the products making up the first 80% of margin, B the next 15%, C the
// rest, anything unsold, and anything sold at a loss.
const A_SHARE = 0.8;
const B_SHARE = 0.95;

export type AbcRank = {
	abc: AbcClass;
	// 1 is the most value.
	rank: number;
	// This product's part of all margin, 0 to 1.
	share: number;
	// Margin in dollars, at least 0.
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
	// Tool sets, ranked among themselves by their own margin (what they sold
	// for less what their parts cost), so an expensive set ranks high on few
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
	// A unit's cost: the supplier's price over the units in their pack if we
	// know it, else what we last valued it at.
	const unitCost = sql<
		number | null
	>`coalesce(${supplierOffers.itemCost}, ${products.unitCost})::float8`;
	const [took, costs, [first], revenue, parts] = await Promise.all([
		soldByLine(db, since, { includeFba: true }),
		db
			.select({
				id: products.id,
				cost: unitCost,
				carried: sql<boolean>`${carried}`,
			})
			.from(products)
			.leftJoin(
				supplierOffers,
				and(
					eq(supplierOffers.productId, products.id),
					eq(supplierOffers.cheapest, true),
				),
			)
			.where(ne(products.kind, "bundle")),
		db.select({ at: sql<string | null>`min(${orders.placedAt})` }).from(orders),
		// What each line sold for, sets as sets, counted the way soldSince
		// counts with FBA.
		db
			.select({
				lineId: orderLines.id,
				productId: orderLines.productId,
				kind: products.kind,
				units: orderLines.quantity,
				revenue: sql<number>`(${orderLines.quantity} * ${orderLines.unitPrice})::float8`,
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.innerJoin(products, eq(products.id, orderLines.productId))
			.where(and(gte(orders.placedAt, since), isNull(orders.cancelledAt))),
		// Each set's parts as they stand, with what one costs, to rank sets.
		db
			.select({
				setId: productComponents.parentProductId,
				partId: productComponents.componentProductId,
				quantity: productComponents.quantity,
				cost: unitCost,
			})
			.from(productComponents)
			.innerJoin(
				products,
				eq(products.id, productComponents.componentProductId),
			)
			.leftJoin(
				supplierOffers,
				and(
					eq(supplierOffers.productId, products.id),
					eq(supplierOffers.cheapest, true),
				),
			),
	]);

	const sold = new Map<number, number>();
	const tookOn = new Map<number, typeof took>();
	for (const t of took) {
		sold.set(t.productId, (sold.get(t.productId) ?? 0) + t.units);
		tookOn.set(t.orderLineId, [...(tookOn.get(t.orderLineId) ?? []), t]);
	}
	const costOf = new Map(costs.map((c) => [c.id, c.cost]));
	const stocked = costs.filter((c) => c.carried);

	// A set's cost, null when any part has none.
	const partsOf = new Map<number, typeof parts>();
	for (const p of parts)
		partsOf.set(p.setId, [...(partsOf.get(p.setId) ?? []), p]);
	const setCost = (setId: number) => {
		const list = partsOf.get(setId) ?? [];
		if (list.length === 0 || list.some((p) => p.cost === null)) return null;
		return list.reduce((sum, p) => sum + p.quantity * (p.cost ?? 0), 0);
	};

	// Revenue per stocked product: its own sales, plus its share of each set
	// sale, split by the cost of the parts that sale took (soldByLine: what it
	// was sold with, not today's recipe). A sale whose parts' cost isn't known
	// can't be split, so it leaves their margin on both sides: no revenue, and
	// the units it took aren't costed either.
	const earned = new Map<number, number>();
	const unvalued = new Map<number, number>();
	const add = (id: number, amount: number) =>
		earned.set(id, (earned.get(id) ?? 0) + amount);
	const setSales = new Map<number, { units: number; revenue: number }>();
	for (const r of revenue) {
		if (r.productId === null) continue;
		if (r.kind !== "bundle") {
			add(r.productId, r.revenue);
			continue;
		}
		const sale = setSales.get(r.productId) ?? { units: 0, revenue: 0 };
		setSales.set(r.productId, {
			units: sale.units + r.units,
			revenue: sale.revenue + r.revenue,
		});
		const lineParts = (tookOn.get(r.lineId) ?? []).map((t) => ({
			...t,
			cost: costOf.get(t.productId) ?? null,
		}));
		if (lineParts.some((p) => p.cost === null)) {
			for (const p of lineParts)
				unvalued.set(p.productId, (unvalued.get(p.productId) ?? 0) + p.units);
			continue;
		}
		// Split by each part's share of the cost. When every part is known to be
		// free there's no cost to split by, so the parts share it by units.
		const cost = lineParts.reduce((sum, p) => sum + p.units * (p.cost ?? 0), 0);
		const weight = (p: { units: number; cost: number | null }) =>
			cost > 0 ? p.units * (p.cost ?? 0) : p.units;
		const whole = lineParts.reduce((sum, p) => sum + weight(p), 0);
		for (const p of lineParts)
			add(p.productId, (r.revenue * weight(p)) / whole);
	}

	let unpriced = 0;
	const rows: { productId: number; value: number; units: number }[] = [];
	for (const p of stocked) {
		const units = sold.get(p.id) ?? 0;
		if (units > 0 && p.cost === null) {
			unpriced++;
			continue;
		}
		const costed = Math.max(0, units - (unvalued.get(p.id) ?? 0));
		const margin = (earned.get(p.id) ?? 0) - costed * (p.cost ?? 0);
		rows.push({ productId: p.id, units, value: Math.max(0, margin) });
	}

	const setRows: typeof rows = [];
	for (const setId of partsOf.keys()) {
		const sale = setSales.get(setId);
		const units = sale?.units ?? 0;
		const cost = setCost(setId);
		if (units > 0 && cost === null) {
			unpriced++;
			continue;
		}
		const margin = (sale?.revenue ?? 0) - units * (cost ?? 0);
		setRows.push({ productId: setId, units, value: Math.max(0, margin) });
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
