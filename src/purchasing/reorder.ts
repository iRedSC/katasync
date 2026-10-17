import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productComponents,
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	settings,
	stockLevels,
	suppliers,
} from "#/db/schema";
import { type AbcClass, type AbcResult, abcClasses } from "#/inventory/abc";
import { setsSoldSince, soldSince } from "#/inventory/sales";
import { afterArrival } from "#/inventory/stock-state";
import {
	DEMAND_DAYS,
	type Forecast,
	forecasts,
	type LeadTime,
	leadTimes,
	NO_FORECAST,
	SERVICE_LEVELS,
	safetyStock,
} from "#/purchasing/forecast";
import {
	type SetMembership,
	type SetRecipeRow,
	setFloorOf,
	setMembership,
	setsBlocked,
} from "#/purchasing/sets";

export { DEMAND_DAYS };

// Everything reorder reads besides stock: each product's forecast, each
// supplier's lead time, and the classes that set how much safety stock to
// hold. Load it once and pass it around when several things need it.
export type Plan = {
	forecasts: Map<number, Forecast>;
	leadTimes: Map<number, LeadTime>;
	abc: AbcResult;
};

export async function loadPlan(
	db: Db,
	now = new Date(),
	abc?: AbcResult | Promise<AbcResult>,
): Promise<Plan> {
	const [f, l, a] = await Promise.all([
		forecasts(db, now),
		leadTimes(db),
		abc ?? abcClasses(db, now),
	]);
	return { forecasts: f, leadTimes: l, abc: a };
}

// A product's demand, lead time, and safety stock under a plan. Without a
// supplier it plans on the suppliers table's defaults.
export function planFor(
	plan: Plan,
	productId: number,
	supplierId: number | null,
) {
	const forecast = plan.forecasts.get(productId) ?? NO_FORECAST;
	const leadTimeDays =
		(supplierId === null ? undefined : plan.leadTimes.get(supplierId)?.days) ??
		DEFAULT_LEAD_TIME_DAYS;
	return {
		dailyDemand: forecast.dailyDemand,
		leadTimeDays,
		safetyStock: safetyStock(
			forecast,
			plan.abc.classes.get(productId)?.abc ?? null,
			leadTimeDays,
		),
	};
}

// What reorder works from for one product. Demand, stock, what's on order,
// and minStock count the product itself; packSize is how many of it one of
// the supplier's units holds.
export type ReorderInput = {
	dailyDemand: number;
	onHand: number;
	onOrder: number;
	leadTimeDays: number;
	safetyStock: number;
	coverDays: number;
	// The product's min stock: never let shelf plus on order drop below it.
	minStock: number;
	// Enough for one of each tool set it's in (see setFloorOf), or 0 in none:
	// below it, some set can't be sold. Holds like minStock.
	setFloor: number;
	minimumQuantity: number;
	packSize: number;
};

// Shelf plus on order, as it stands once what's ordered arrives. Oversold
// stock counts as 0, since receiving writes it off.
function position(p: ReorderInput) {
	return afterArrival(p.onHand, p.onOrder);
}

// Below this, a product needs ordering: what sells before a PO sent today
// arrives plus its safety stock, or its min stock if that's more.
function reorderPoint(p: ReorderInput) {
	return Math.max(
		p.dailyDemand * p.leadTimeDays + p.safetyStock,
		floorOf(p),
		oversoldFloor(p),
	);
}

// Oversold with nothing on order: the shelf owes units nobody is bringing,
// so order at least one even with no recent sales or min stock.
function oversoldFloor(p: ReorderInput) {
	return p.onHand < 0 && p.onOrder === 0 ? 1 : 0;
}

// The least shelf plus on order may be: min stock, or one of each of its
// tool sets if that's more.
const floorOf = (p: ReorderInput) => Math.max(p.minStock, p.setFloor);

// How many of the supplier's unit it takes to top stock up to its target
// (stockTarget, or its floor or the oversold floor if more), rounded up to
// whole units and to at least the supplier's minimum. 0 when it's already
// there.
function topUp(p: ReorderInput) {
	const need =
		Math.max(stockTarget(p), floorOf(p), oversoldFloor(p)) - position(p);
	if (need <= 0) return 0;
	return Math.max(Math.ceil(need / p.packSize), p.minimumQuantity);
}

// How many of the supplier's unit to order, or 0 to leave it off the PO: a
// top-up once shelf plus on order drops below the reorder point.
export function reorderQuantity(p: ReorderInput): number {
	return position(p) < reorderPoint(p) ? topUp(p) : 0;
}

// Days until a product that doesn't need ordering yet will, at its current
// sales. null when it never will (no sales) or already does.
export function daysUntilReorder(p: ReorderInput): number | null {
	const left = position(p) - reorderPoint(p);
	if (p.dailyDemand === 0 || left < 0) return null;
	return Math.floor(left / p.dailyDemand);
}

// What a reorder tops stock up to: enough to last until a PO sent today
// arrives and coverDays past it, plus safety stock. Also the default max.
export function stockTarget(p: {
	dailyDemand: number;
	leadTimeDays: number;
	safetyStock: number;
	coverDays: number;
}) {
	return Math.ceil(
		p.dailyDemand * (p.leadTimeDays + p.coverDays) + p.safetyStock,
	);
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

// How many of the supplier's unit fill stock up to max, rounded up to whole
// units and to at least the supplier's minimum. 0 when it's already there.
function fillToMax(p: ReorderInput, max: number) {
	const need = max - position(p);
	if (need <= 0) return 0;
	return Math.max(Math.ceil(need / p.packSize), p.minimumQuantity);
}

// What products without a supplier forecast with: the suppliers table's own
// defaults.
export const DEFAULT_LEAD_TIME_DAYS = 14;
export const DEFAULT_COVER_DAYS = 30;

// What reorder decided for one product, in the pieces a person can check.
// The parts of `aim` add up to `aim.total` exactly, so a breakdown built from
// them never disagrees with the quantity.
export type ReorderWhy = {
	// Units a day while in stock, over inStockDays of the last DEMAND_DAYS.
	dailyDemand: number;
	inStockDays: number;
	// Share of selling products it outsells, 0 to 1. Null when it hasn't sold.
	rank: number | null;
	leadTime: {
		days: number;
		// measured: from the supplier's last `pos` deliveries. supplier: what
		// its settings say. default: no supplier, so DEFAULT_LEAD_TIME_DAYS.
		from: "measured" | "supplier" | "default";
		pos: number;
	};
	coverDays: number;
	abc: AbcClass | null;
	// How sure the safety stock makes us of not running out, 0 to 1.
	serviceShare: number;
	onHand: number;
	onOrder: number;
	// What a reorder tops shelf plus on order up to.
	aim:
		| {
				kind: "forecast";
				// Sold while a PO sent today is on its way.
				restock: number;
				safetyStock: number;
				// Sold over coverDays after it lands.
				cover: number;
				total: number;
		  }
		// The floor (minStock) is more than the forecast's aim, so it is the aim.
		| { kind: "min"; total: number; forecast: number };
	// The least shelf plus on order may be, and where it comes from: the
	// product's min stock, or one of each of its tool sets when that's more.
	minStock: number;
	minFrom: "stock" | "sets";
	// The tool sets it's a part of, and its shelf to build them from.
	sets: SetMembership;
	// Reorder happens once shelf plus on order is below this.
	orderBelow: number;
	// What it's bought in. Null without a supplier: it can't be ordered yet.
	purchase: {
		unit: string;
		packSize: number;
		supplierCount: number;
		minimumQuantity: number;
	} | null;
	verdict:
		| {
				kind: "order";
				// In the supplier's unit; `units` counts the product.
				quantity: number;
				units: number;
				// Why units is more than the shortfall, if it is.
				roundedUp: "pack" | "minimum" | null;
		  }
		| { kind: "later"; days: number }
		// No sales and nothing below min: nothing will ever need ordering.
		| { kind: "idle" };
};

// Explains reorderQuantity's answer for `p` using the same functions, so the
// two can't drift apart.
export function explainReorder(
	p: ReorderInput,
	context: {
		inStockDays: number;
		rank: number | null;
		leadTime: ReorderWhy["leadTime"];
		abc: AbcClass | null;
		purchase: ReorderWhy["purchase"];
		sets: SetMembership;
	},
): ReorderWhy {
	const forecastAim = stockTarget(p);
	const floor = floorOf(p);
	// Rounded the way reorderPoint compares: whole units under it reorder.
	const restock = Math.ceil(p.dailyDemand * p.leadTimeDays);
	const aim: ReorderWhy["aim"] =
		floor > forecastAim
			? { kind: "min", total: floor, forecast: forecastAim }
			: {
					kind: "forecast",
					restock,
					safetyStock: p.safetyStock,
					cover: forecastAim - restock - p.safetyStock,
					total: forecastAim,
				};
	const quantity = reorderQuantity(p);
	const days = daysUntilReorder(p);
	const shortfall = aim.total - position(p);
	const verdict: ReorderWhy["verdict"] =
		quantity > 0
			? {
					kind: "order",
					quantity,
					units: quantity * p.packSize,
					roundedUp:
						quantity === p.minimumQuantity &&
						p.minimumQuantity > Math.ceil(shortfall / p.packSize)
							? "minimum"
							: quantity * p.packSize > shortfall
								? "pack"
								: null,
				}
			: days === null
				? { kind: "idle" }
				: { kind: "later", days };
	return {
		dailyDemand: p.dailyDemand,
		inStockDays: context.inStockDays,
		rank: context.rank,
		leadTime: context.leadTime,
		coverDays: p.coverDays,
		abc: context.abc,
		serviceShare: SERVICE_LEVELS[context.abc ?? "C"].share,
		onHand: p.onHand,
		onOrder: p.onOrder,
		aim,
		minStock: floor,
		minFrom: p.setFloor > p.minStock ? "sets" : "stock",
		sets: context.sets,
		orderBelow: Math.ceil(reorderPoint(p)),
		purchase: context.purchase,
		verdict,
	};
}

// Each selling product's share of selling products it outsells, 0 to 1:
// the fastest is 1, the slowest 0. Ties share the lower share.
export function velocityRanks(forecasts: Map<number, Forecast>) {
	const selling = [...forecasts]
		.filter(([, f]) => f.dailyDemand > 0)
		.sort(([, a], [, b]) => a.dailyDemand - b.dailyDemand);
	const ranks = new Map<number, number>();
	let below = 0;
	selling.forEach(([id, f], i) => {
		if (i > 0 && f.dailyDemand > selling[i - 1][1].dailyDemand) below = i;
		ranks.set(id, selling.length === 1 ? 1 : below / (selling.length - 1));
	});
	return ranks;
}

export type SuggestedLine = {
	productId: number;
	sku: string;
	name: string;
	variantName: string | null;
	imageUrl: string | null;
	supplierSku: string | null;
	// What it's ordered in. quantity and unitCost are per unit; onHand,
	// onOrder, and sold count the product.
	unit: string;
	packSize: number;
	supplierCount: number;
	minimumQuantity: number;
	onHand: number;
	onOrder: number;
	// Units sold over DEMAND_DAYS, counting tool sets as their parts.
	sold: number;
	quantity: number;
	unitCost: number | null;
	// Marked critical, an A item, or leaving a tool set unsellable (see
	// isCritical).
	critical: boolean;
};

// Why a supplier's suggested PO is ready to send, if it is. "critical": at
// least criticalThreshold of its products are critical, so it goes now
// whatever the total. "minimum": the total reached the supplier's minimum
// order. "waiting": neither yet.
export type Readiness = "critical" | "minimum" | "waiting";

export type SupplierSuggestion = {
	supplierId: number;
	supplierName: string;
	minimumOrder: number;
	criticalThreshold: number;
	lines: SuggestedLine[];
	// Lines without a price add nothing here.
	total: number;
	unpriced: number;
	// How many lines are critical.
	critical: number;
	readiness: Readiness;
	draftId: number | null;
};

// Suggestions to start a PO from: ready, and not already on a draft. Once a
// supplier has a draft, its suggestion lives there (see draftChanges).
export function readyToOrder(
	suggestions: SupplierSuggestion[],
): Omit<SupplierSuggestion, "draftId">[] {
	return suggestions
		.filter((s) => s.readiness !== "waiting" && s.draftId === null)
		.map(({ draftId: _, ...s }) => s);
}

export function readiness(s: {
	total: number;
	minimumOrder: number;
	critical: number;
	criticalThreshold: number;
}): Readiness {
	if (s.critical >= s.criticalThreshold) return "critical";
	if (s.total >= s.minimumOrder) return "minimum";
	return "waiting";
}

// A product we can't run out of: marked critical by hand, one of the A items
// that make most of the sales, or a part some tool set can't be built
// without, since the set sells nothing until it arrives.
export const isCritical = (
	marked: boolean,
	abc: AbcClass | null,
	setsBlocked: number,
) => marked || abc === "A" || setsBlocked > 0;

// Whether a product that needs ordering goes on its supplier's PO by itself:
// A and B items, which earn enough to always keep, anything marked critical,
// and parts that leave a tool set unsellable, since the set's sales wait on
// them. The rest (C items, and unpriced ones that can't be classed) are
// recommended instead, so someone decides whether they're worth restocking.
export const ordersItself = (
	marked: boolean,
	abc: AbcClass | null,
	setsBlocked: number,
) => marked || abc === "A" || abc === "B" || setsBlocked > 0;

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
			.where(productIds ? inArray(products.id, productIds) : undefined)
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
			quantity: reorderQuantity(input),
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

export type RecommendedLine = SuggestedLine & {
	// "now": it needs ordering today but doesn't go on POs by itself (see
	// ordersItself). Otherwise the days until it would need ordering anyway.
	due: "now" | number;
	// What its line shows once added, so the PO can show it before the server
	// has it.
	kind: Breakdown["kind"];
	barcode: string | null;
	stockRange: Breakdown["range"];
	why: Breakdown["why"];
};

type Breakdown = Awaited<ReturnType<typeof reorderBreakdown>>[number];

// A supplier's products worth adding to its PO, each at the quantity that
// fills it to its max. First the ones that need ordering today but don't go
// on POs by themselves; then the ones that don't need ordering yet but will
// before its next PO would (within its cover days), soonest first, since
// ordering them now saves a second shipment. Products in `except` (already on
// the draft) and dormant C items (see reorderBreakdown) are left out.
export async function recommendedAdditions(
	db: Db,
	supplierId: number,
	except: Set<number>,
	now = new Date(),
): Promise<RecommendedLine[]> {
	const plans = await reorderBreakdown(db, { now });
	return plans
		.flatMap((plan): RecommendedLine[] => {
			const { line, supplier, input } = plan;
			if (
				supplier?.supplierId !== supplierId ||
				except.has(line.productId) ||
				plan.dormant
			)
				return [];
			const due = recommendedDue(plan);
			const quantity = fillToMax(input, plan.max);
			if (due === null || quantity === 0) return [];
			return [
				{
					...line,
					quantity,
					due,
					kind: plan.kind,
					barcode: plan.barcode,
					stockRange: plan.range,
					why: plan.why,
				},
			];
		})
		.sort((a, b) => dueOrder(a.due) - dueOrder(b.due));
}

// When a product is due, if that makes it worth recommending: now if it
// needs ordering but its PO won't take it by itself, else within cover days.
function recommendedDue({
	line,
	input,
	ordersItself,
}: Breakdown): RecommendedLine["due"] | null {
	if (line.quantity > 0) return ordersItself ? null : "now";
	const days = daysUntilReorder(input);
	return days === null || days > input.coverDays ? null : days;
}

const dueOrder = (due: RecommendedLine["due"]) => (due === "now" ? -1 : due);

// What each supplier should be sent today: what needs ordering among the
// products that go on POs by themselves (see ordersItself). Computed fresh from sales, stock,
// and open POs rather than stored, so it never goes stale.
export async function suggestPurchases(
	db: Db,
	now = new Date(),
): Promise<SupplierSuggestion[]> {
	const [breakdown, drafts] = await Promise.all([
		reorderBreakdown(db, { now }),
		db
			.select({ id: purchaseOrders.id, supplierId: purchaseOrders.supplierId })
			.from(purchaseOrders)
			.where(eq(purchaseOrders.status, "draft")),
	]);

	const bySupplier = new Map<number, SupplierSuggestion>();
	for (const {
		supplierId,
		supplierName,
		minimumOrder,
		criticalThreshold,
		...line
	} of needsOf(breakdown.filter((p) => p.ordersItself))) {
		let s = bySupplier.get(supplierId);
		if (!s) {
			s = {
				supplierId,
				supplierName,
				minimumOrder,
				criticalThreshold,
				lines: [],
				total: 0,
				unpriced: 0,
				critical: 0,
				readiness: "waiting",
				draftId: drafts.find((d) => d.supplierId === supplierId)?.id ?? null,
			};
			bySupplier.set(supplierId, s);
		}
		s.lines.push(line);
		if (line.critical) s.critical++;
		if (line.unitCost === null) s.unpriced++;
		else s.total += line.quantity * line.unitCost;
	}

	const result = [...bySupplier.values()];
	for (const s of result) {
		s.total = Math.round(s.total * 100) / 100;
		s.readiness = readiness(s);
	}
	// Ready first (critical before minimum), then the biggest orders.
	const rank = { critical: 0, minimum: 1, waiting: 2 } as const;
	return result.sort(
		(a, b) => rank[a.readiness] - rank[b.readiness] || b.total - a.total,
	);
}

// Every tool set's recipe, with what each set shows as a product. A kit's
// parts are in the kit, not a set.
export async function setRecipes(db: Db): Promise<SetRecipeRow[]> {
	const rows = await db
		.select({
			setId: productComponents.parentProductId,
			productId: productComponents.componentProductId,
			perSet: productComponents.quantity,
			sku: products.sku,
			name: products.name,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
		})
		.from(productComponents)
		.innerJoin(products, eq(products.id, productComponents.parentProductId))
		.where(eq(products.kind, "bundle"));
	return rows.map(({ setId, productId, perSet, ...set }) => ({
		setId,
		productId,
		perSet,
		set,
	}));
}

// One product's tool sets, as reorderBreakdown works them out, or null when
// it's in none.
export async function membershipOf(
	db: Db,
	productId: number,
	now = new Date(),
): Promise<SetMembership | null> {
	const since = new Date(now.getTime() - DEMAND_DAYS * 86_400_000);
	const [recipes, onHand, sold] = await Promise.all([
		setRecipes(db),
		ownedOnHand(db),
		setsSoldSince(db, since),
	]);
	return setMembership(recipes, onHand, sold).get(productId) ?? null;
}

// On hand across our own locations. Negative (oversold) stays negative, so it
// gets bought back.
async function ownedOnHand(db: Db) {
	const rows = await db
		.select({
			productId: stockLevels.productId,
			onHand: sql<number>`sum(${stockLevels.onHand})::int`,
		})
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(eq(locations.kind, "owned"))
		.groupBy(stockLevels.productId);
	return new Map(rows.map((r) => [r.productId, r.onHand]));
}

const receivedByLine = (db: Db) =>
	db
		.select({
			lineId: purchaseOrderReceipts.lineId,
			units: sql<number>`sum(${purchaseOrderReceipts.quantity})`.as("units"),
		})
		.from(purchaseOrderReceipts)
		.groupBy(purchaseOrderReceipts.lineId)
		.as("received");

// How many of each product are on sent POs and haven't arrived yet, counting
// the product itself (2 cases of 30 is 60). Drafts aren't on order.
export async function unitsOnOrder(db: Db, productIds?: number[]) {
	const received = receivedByLine(db);
	const rows = await db
		.select({
			productId: purchaseOrderLines.productId,
			units: sql<number>`sum(greatest(${purchaseOrderLines.quantity} - coalesce(${received.units}, 0), 0) * ${purchaseOrderLines.packSize})::int`,
		})
		.from(purchaseOrderLines)
		.innerJoin(
			purchaseOrders,
			eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
		)
		.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
		.where(
			and(
				eq(purchaseOrders.status, "sent"),
				productIds
					? inArray(purchaseOrderLines.productId, productIds)
					: undefined,
			),
		)
		.groupBy(purchaseOrderLines.productId);
	return new Map(rows.map((r) => [r.productId, r.units]));
}

// Each product's line on an open draft. A product has one supplier, so one
// draft; if it moved suppliers with a draft still open, the newest PO wins.
export async function draftLines(db: Db) {
	const rows = await db
		.select({
			productId: purchaseOrderLines.productId,
			purchaseOrderId: purchaseOrders.id,
			quantity: purchaseOrderLines.quantity,
			unit: purchaseOrderLines.unit,
			packSize: purchaseOrderLines.packSize,
			supplierCount: purchaseOrderLines.supplierCount,
		})
		.from(purchaseOrderLines)
		.innerJoin(
			purchaseOrders,
			eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
		)
		.where(eq(purchaseOrders.status, "draft"))
		.orderBy(purchaseOrders.id);
	return new Map(rows.map(({ productId, ...line }) => [productId, line]));
}

// Unreceived products on sent POs, counted like unitsOnOrder, with the day
// each is due, soonest first. A PO without an expected date is due its
// supplier's lead time after it was sent. Ones already past due aren't coming
// on any day we can plan around, so they are left out.
async function arrivingUnits(db: Db, now: Date, lead: Map<number, LeadTime>) {
	const received = receivedByLine(db);
	const rows = await db
		.select({
			productId: purchaseOrderLines.productId,
			units: sql<number>`(greatest(${purchaseOrderLines.quantity} - coalesce(${received.units}, 0), 0) * ${purchaseOrderLines.packSize})::int`,
			expectedAt: purchaseOrders.expectedAt,
			sentAt: purchaseOrders.sentAt,
			supplierId: purchaseOrders.supplierId,
			leadTimeDays: suppliers.leadTimeDays,
		})
		.from(purchaseOrderLines)
		.innerJoin(
			purchaseOrders,
			eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
		)
		.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
		.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
		.where(eq(purchaseOrders.status, "sent"));

	const byProduct = new Map<number, { units: number; arrivesAt: number }[]>();
	for (const r of rows) {
		const arrivesAt =
			r.expectedAt?.getTime() ??
			(r.sentAt ?? now).getTime() +
				(lead.get(r.supplierId)?.days ?? r.leadTimeDays) * 86_400_000;
		if (r.units === 0 || arrivesAt < now.getTime()) continue;
		const list = byProduct.get(r.productId) ?? [];
		list.push({ units: r.units, arrivesAt });
		byProduct.set(r.productId, list);
	}
	for (const list of byProduct.values())
		list.sort((a, b) => a.arrivesAt - b.arrivesAt);
	return byProduct;
}

// A products that will run out before a PO sent today could arrive. Units on
// order only count if they land before the shelf empties. Products without a
// supplier use the default lead time, since they still have to come from
// somewhere.
export async function aItemsAtRisk(db: Db, now = new Date()) {
	const plan = await loadPlan(db, now);
	const [onHand, arriving] = await Promise.all([
		ownedOnHand(db),
		arrivingUnits(db, now, plan.leadTimes),
	]);
	const aIds = [...plan.abc.classes]
		.filter(([, c]) => c.abc === "A")
		.map(([id]) => id);
	if (aIds.length === 0) return [];
	const rows = await db
		.select({
			id: products.id,
			sku: products.sku,
			name: products.name,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
			supplierId: suppliers.id,
		})
		.from(products)
		.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
		.leftJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
		.where(inArray(products.id, aIds));

	return rows
		.flatMap((p) => {
			const { dailyDemand, leadTimeDays } = planFor(plan, p.id, p.supplierId);
			if (dailyDemand === 0) return [];
			// Each PO extends the stock only if it arrives before it runs out.
			let position = onHand.get(p.id) ?? 0;
			for (const po of arriving.get(p.id) ?? []) {
				const daysAway = (po.arrivesAt - now.getTime()) / 86_400_000;
				if (daysAway * dailyDemand > position) break;
				position += po.units;
			}
			if (position >= dailyDemand * leadTimeDays) return [];
			return [
				{
					sku: p.sku,
					name: p.name,
					variantName: p.variantName,
					imageUrl: p.imageUrl,
					// Days until the shelf and the POs that land in time run out.
					daysLeft: Math.max(0, Math.floor(position / dailyDemand)),
					leadTimeDays,
				},
			];
		})
		.sort((a, b) => a.daysLeft - b.daysLeft);
}
