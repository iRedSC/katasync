import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productSuppliers,
	products,
	settings,
	stockLevels,
	suppliers,
} from "#/db/schema";
import { setsSoldSince, soldSince } from "#/inventory/sales";
import { carried } from "#/products/archive";
import { DEMAND_DAYS } from "#/purchasing/forecast";
import { setFloorOf, setMembership, setsBlocked } from "#/purchasing/sets";
import { DEFAULT_COVER_DAYS, loadPlan, type Plan, planFor } from "./plan";
import {
	explainReorder,
	forecastMax,
	type ReorderInput,
	reorderQuantity,
	velocityRanks,
} from "./quantity";
import { ownedOnHand, setRecipes, unitsOnOrder } from "./stock";
import { isCritical, ordersItself, type SuggestedLine } from "./suggested";

type Supplier = {
	supplierId: number;
	supplierName: string;
	minimumOrder: number;
	criticalThreshold: number;
};

// One product that needs ordering, with the supplier it comes from.
export type ReorderNeed = SuggestedLine & Supplier;

// Every product as reorder sees it today, in name order, with why. Products
// without a supplier plan on the defaults and have no supplier fields.
// `productIds` limits it to those products. Pass `plan` when the caller
// already has one, to skip loading it twice.
export async function reorderBreakdown(
	db: Db,
	options: {
		now?: Date;
		plan?: Plan | Promise<Plan>;
		productIds?: number[];
	} = {},
) {
	const { now = new Date(), productIds } = options;
	if (productIds?.length === 0) return [];
	const since = new Date(now.getTime() - DEMAND_DAYS * 86_400_000);
	const [
		sold,
		onHand,
		onOrder,
		defaultMin,
		rows,
		planned,
		counted,
		setsSold,
		recipes,
	] = await Promise.all([
		soldSince(db, since, { includeFba: false }),
		ownedOnHand(db),
		unitsOnOrder(db, productIds),
		// Read here rather than from inventory/stock-range, which imports this
		// file.
		db
			.select({ min: settings.defaultMinStock })
			.from(settings)
			.then(([row]) => {
				if (!row) throw new Error("The settings row is missing");
				return row.min;
			}),
		db
			.select({
				productId: products.id,
				sku: products.sku,
				kind: products.kind,
				barcode: products.barcode,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				productCost: products.unitCost,
				markedCritical: products.critical,
				notCounted: sql<boolean>`${products.notCountedSince} is not null`,
				minStock: products.minStock,
				maxStock: products.maxStock,
				supplierSku: productSuppliers.supplierSku,
				cost: productSuppliers.cost,
				minimumQuantity: productSuppliers.minimumQuantity,
				unit: productSuppliers.unit,
				packSize: productSuppliers.packSize,
				supplierCount: productSuppliers.supplierCount,
				supplierId: suppliers.id,
				supplierName: suppliers.name,
				coverDays: suppliers.coverDays,
				minimumOrder: suppliers.minimumOrder,
				criticalThreshold: suppliers.criticalThreshold,
			})
			.from(products)
			.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
			.leftJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
			.where(
				and(carried, productIds ? inArray(products.id, productIds) : undefined),
			)
			.orderBy(products.name, products.variantName),
		options.plan ?? loadPlan(db, now),
		// Products counted on any of our own shelves, ever.
		db
			.selectDistinct({ productId: stockLevels.productId })
			.from(stockLevels)
			.innerJoin(locations, eq(locations.id, stockLevels.locationId))
			.where(
				and(eq(locations.kind, "owned"), isNotNull(stockLevels.lastCountedAt)),
			)
			.then((rows) => new Set(rows.map((r) => r.productId))),
		setsSoldSince(db, since),
		setRecipes(db),
	]);
	const ranks = velocityRanks(planned.forecasts);
	const sets = setMembership(recipes, onHand, setsSold);

	return rows.map((p) => {
		const rank = planned.abc.classes.get(p.productId);
		const abcClass = rank?.abc ?? null;
		const membership = sets.get(p.productId) ?? {
			shelf: Math.max(onHand.get(p.productId) ?? 0, 0),
			sets: [],
		};
		const blocked = setsBlocked(membership);
		// The joins make these all null together, or none.
		const supplier: Supplier | null =
			p.supplierId === null ||
			p.supplierName === null ||
			p.minimumOrder === null ||
			p.criticalThreshold === null
				? null
				: {
						supplierId: p.supplierId,
						supplierName: p.supplierName,
						minimumOrder: p.minimumOrder,
						criticalThreshold: p.criticalThreshold,
					};
		const purchase =
			supplier &&
			p.unit !== null &&
			p.packSize !== null &&
			p.supplierCount !== null
				? {
						unit: p.unit,
						packSize: p.packSize,
						supplierCount: p.supplierCount,
						minimumQuantity: p.minimumQuantity ?? 1,
					}
				: null;
		const stock = {
			sold: sold.get(p.productId) ?? 0,
			onHand: onHand.get(p.productId) ?? 0,
			onOrder: onOrder.get(p.productId) ?? 0,
		};
		const terms = purchase ?? {
			unit: "EACH",
			packSize: 1,
			supplierCount: 1,
			minimumQuantity: 1,
		};
		const input: ReorderInput = {
			...stock,
			...planFor(planned, p.productId, p.supplierId),
			coverDays: p.coverDays ?? DEFAULT_COVER_DAYS,
			minStock: p.minStock ?? defaultMin,
			setFloor: setFloorOf(membership),
			minimumQuantity: terms.minimumQuantity,
			packSize: terms.packSize,
		};
		const line: SuggestedLine = {
			productId: p.productId,
			sku: p.sku,
			name: p.name,
			variantName: p.variantName,
			imageUrl: p.imageUrl,
			supplierSku: p.supplierSku,
			...terms,
			...stock,
			// Until it's counted its number means nothing, so nothing is ordered
			// from it (src/inventory/not-counted.ts).
			quantity: p.notCounted ? 0 : reorderQuantity(input),
			// The supplier's price if we know it, else what we last valued it at.
			unitCost:
				p.cost ??
				(p.productCost === null ? null : p.productCost * terms.packSize),
			critical: isCritical(p.markedCritical, abcClass, blocked),
		};
		const lead =
			p.supplierId === null ? undefined : planned.leadTimes.get(p.supplierId);
		const why = explainReorder(input, {
			inStockDays: planned.forecasts.get(p.productId)?.inStockDays ?? 0,
			rank: ranks.get(p.productId) ?? null,
			leadTime: {
				days: input.leadTimeDays,
				from: lead?.measured ? "measured" : lead ? "supplier" : "default",
				pos: lead?.measured?.pos ?? 0,
			},
			abc: abcClass,
			purchase,
			sets: membership,
		});
		// Its own range, else the one its forecast gives, as stockRanges does.
		const range =
			p.minStock !== null && p.maxStock !== null
				? { min: p.minStock, max: p.maxStock, own: true }
				: { min: defaultMin, max: forecastMax(defaultMin, input), own: false };
		return {
			line,
			supplier,
			input,
			why,
			kind: p.kind,
			barcode: p.barcode,
			range,
			max: range.max,
			ordersItself: ordersItself(p.markedCritical, abcClass, blocked),
			notCounted: p.notCounted,
			// A C item nobody has sold or counted in a year is dead stock, or
			// was never really stocked: nothing to recommend. Unpriced products
			// have no class but did sell, so they stay.
			dormant:
				rank?.abc === "C" && rank.units === 0 && !counted.has(p.productId),
		};
	});
}

// Every product with a supplier that needs ordering today, in name order.
// Pass `plan` when the caller already has one, to skip loading it twice.
export async function reorderNeeds(
	db: Db,
	now = new Date(),
	plan?: Plan | Promise<Plan>,
): Promise<ReorderNeed[]> {
	return needsOf(await reorderBreakdown(db, { now, plan }));
}

export function needsOf(
	breakdown: Awaited<ReturnType<typeof reorderBreakdown>>,
): ReorderNeed[] {
	return breakdown.flatMap(({ line, supplier }) =>
		supplier && line.quantity > 0 ? [{ ...line, ...supplier }] : [],
	);
}
