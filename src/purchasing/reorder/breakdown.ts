import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import {
	locations,
	products,
	settings,
	stockLevels,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { isOurs } from "#/inventory/locations";
import { carried } from "#/products/archive";
import { cheapestOffers } from "#/purchasing/catalogs";
import { demandWindow, setsSoldIn, soldInWindow } from "#/purchasing/forecast";
import { setFloorOf, setMembership, setsBlocked } from "#/purchasing/sets";
import { DEFAULT_COVER_DAYS, loadPlan, type Plan, planFor } from "./plan";
import {
	explainReorder,
	forecastMax,
	type ReorderInput,
	reorderQuantity,
	velocityRanks,
} from "./quantity";
import { setRecipes, stockAndOrders } from "./stock";
import { isCritical, ordersItself, type SuggestedLine } from "./suggested";

type Supplier = {
	supplierId: number;
	supplierName: string;
	minimumOrder: number;
	criticalThreshold: number;
};

// One product that needs ordering, with the supplier it comes from.
export type ReorderNeed = SuggestedLine & Supplier;

// Who sells a product for less than the supplier it's being planned from.
export type CheaperAt = {
	supplierId: number;
	supplierName: string;
	// Short enough for a badge, e.g. "FCI".
	supplierCode: string;
	// Per single item, at each supplier.
	itemCost: number;
	ours: number | null;
};

const cheapestSupplier = alias(suppliers, "cheapest_supplier");

// Every product as reorder sees it today, in name order, with why. Each is
// bought from its cheapest supplier (supplierOffers), or with `from`, from
// that supplier and over its cover days unless `coverDays` says otherwise;
// `cheaperAt` then says who sells it for less. Products nobody sells plan on
// the defaults and have no supplier fields. `productIds` limits it to those
// products. Pass `plan` when the caller already has one, to skip loading it
// twice.
export async function reorderBreakdown(
	db: Db,
	options: {
		now?: Date;
		plan?: Plan | Promise<Plan>;
		productIds?: number[];
		from?: { supplierId: number; coverDays?: number | null };
	} = {},
) {
	const { now = new Date(), productIds, from } = options;
	const cheapestOffer = cheapestOffers(db);
	if (productIds?.length === 0) return [];
	// The same window the forecast's days are read over, so the sales shown
	// and the explanation for them cover the same orders.
	const demand = demandWindow(now);
	const [sold, supply, defaultMin, rows, planned, counted, setsSold, recipes] =
		await Promise.all([
			soldInWindow(db, demand),
			// On hand and on order are read together, so they're from one moment.
			stockAndOrders(db, productIds),
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
					markedCritical: products.critical,
					notCounted: sql<boolean>`${products.notCountedSince} is not null`,
					minStock: products.minStock,
					maxStock: products.maxStock,
					catalogId: products.catalogId,
					supplierSku: supplierOffers.supplierSku,
					cost: supplierOffers.cost,
					itemCost: supplierOffers.itemCost,
					minimumQuantity: supplierOffers.minimumQuantity,
					unit: supplierOffers.unit,
					packSize: supplierOffers.packSize,
					supplierCount: supplierOffers.supplierCount,
					supplierId: suppliers.id,
					supplierName: suppliers.name,
					coverDays: suppliers.coverDays,
					minimumOrder: suppliers.minimumOrder,
					criticalThreshold: suppliers.criticalThreshold,
					cheapestId: cheapestSupplier.id,
					cheapestName: cheapestSupplier.name,
					cheapestCode: cheapestSupplier.code,
					cheapestItemCost: cheapestOffer.itemCost,
				})
				.from(products)
				.leftJoin(
					supplierOffers,
					and(
						eq(supplierOffers.productId, products.id),
						from
							? eq(supplierOffers.supplierId, from.supplierId)
							: eq(supplierOffers.cheapest, true),
					),
				)
				.leftJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
				.leftJoin(cheapestOffer, eq(cheapestOffer.productId, products.id))
				.leftJoin(
					cheapestSupplier,
					eq(cheapestSupplier.id, cheapestOffer.supplierId),
				)
				.where(
					and(
						carried,
						productIds ? inArray(products.id, productIds) : undefined,
					),
				)
				.orderBy(products.name, products.variantName),
			options.plan ?? loadPlan(db, now),
			// Products counted on any of our own shelves, ever.
			db
				.selectDistinct({ productId: stockLevels.productId })
				.from(stockLevels)
				.innerJoin(locations, eq(locations.id, stockLevels.locationId))
				.where(and(isOurs, isNotNull(stockLevels.lastCountedAt)))
				.then((rows) => new Set(rows.map((r) => r.productId))),
			setsSoldIn(db, demand),
			setRecipes(db),
		]);
	const { onHand, onOrder } = supply;
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
			coverDays: from?.coverDays ?? p.coverDays ?? DEFAULT_COVER_DAYS,
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
			// The supplier's price, or none: our average cost isn't theirs.
			unitCost: p.cost,
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
		// Only with `from`: the cheapest is someone else, at a known lower
		// price. An unpriced offer loses to any priced one.
		const cheaperAt: CheaperAt | null =
			supplier &&
			p.cheapestId !== null &&
			p.cheapestName !== null &&
			p.cheapestCode !== null &&
			p.cheapestId !== supplier.supplierId &&
			p.cheapestItemCost !== null &&
			(p.itemCost === null || p.cheapestItemCost < p.itemCost)
				? {
						supplierId: p.cheapestId,
						supplierName: p.cheapestName,
						supplierCode: p.cheapestCode,
						itemCost: p.cheapestItemCost,
						ours: p.itemCost,
					}
				: null;
		// Its own range, else the one its forecast gives, as stockRanges does.
		const range =
			p.minStock !== null && p.maxStock !== null
				? { min: p.minStock, max: p.maxStock, own: true }
				: { min: defaultMin, max: forecastMax(defaultMin, input), own: false };
		return {
			line,
			supplier,
			catalogId: p.catalogId,
			// The supplier planned from is the one reorder buys it from.
			cheapest: supplier !== null && p.cheapestId === supplier.supplierId,
			cheaperAt,
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
