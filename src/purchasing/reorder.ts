import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
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
import { soldSince } from "#/inventory/sales";
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
	minimumQuantity: number;
	packSize: number;
};

// Below this, a product needs ordering: what sells before a PO sent today
// arrives plus its safety stock, or its min stock if that's more. Oversold
// stock (negative) is always below it.
function reorderPoint(p: ReorderInput) {
	return Math.max(p.dailyDemand * p.leadTimeDays + p.safetyStock, p.minStock);
}

// How many of the supplier's unit it takes to top stock up to its target
// (stockTarget, or min stock if that's more), rounded up to whole units and
// to at least the supplier's minimum. 0 when it's already there.
function topUp(p: ReorderInput) {
	const need = Math.max(stockTarget(p), p.minStock) - (p.onHand + p.onOrder);
	if (need <= 0) return 0;
	return Math.max(Math.ceil(need / p.packSize), p.minimumQuantity);
}

// How many of the supplier's unit to order, or 0 to leave it off the PO: a
// top-up once shelf plus on order drops below the reorder point.
export function reorderQuantity(p: ReorderInput): number {
	return p.onHand + p.onOrder < reorderPoint(p) ? topUp(p) : 0;
}

// Days until a product that doesn't need ordering yet will, at its current
// sales. null when it never will (no sales) or already does.
export function daysUntilReorder(p: ReorderInput): number | null {
	const left = p.onHand + p.onOrder - reorderPoint(p);
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
		// Min stock is more than the forecast's aim, so it is the aim.
		| { kind: "min"; total: number; forecast: number };
	minStock: number;
	// Reorder happens once shelf plus on order is below this.
	orderBelow: number;
	// What it's bought in. Null without a supplier: it can't be ordered yet.
	purchase: { unit: string; packSize: number; minimumQuantity: number } | null;
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
	},
): ReorderWhy {
	const forecastAim = stockTarget(p);
	// Rounded the way reorderPoint compares: whole units under it reorder.
	const restock = Math.ceil(p.dailyDemand * p.leadTimeDays);
	const aim: ReorderWhy["aim"] =
		p.minStock > forecastAim
			? { kind: "min", total: p.minStock, forecast: forecastAim }
			: {
					kind: "forecast",
					restock,
					safetyStock: p.safetyStock,
					cover: forecastAim - restock - p.safetyStock,
					total: forecastAim,
				};
	const quantity = reorderQuantity(p);
	const days = daysUntilReorder(p);
	const shortfall = aim.total - (p.onHand + p.onOrder);
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
		minStock: p.minStock,
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
	minimumQuantity: number;
	onHand: number;
	onOrder: number;
	// Units sold over DEMAND_DAYS, counting tool sets as their parts.
	sold: number;
	quantity: number;
	unitCost: number | null;
	// Marked critical, or an A item (see isCritical).
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

// A product we can't run out of: marked critical by hand, or one of the A
// items that make most of the sales.
export const isCritical = (marked: boolean, abc: AbcClass | null) =>
	marked || abc === "A";

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
	const [sold, onHand, onOrder, defaultMin, rows, planned] = await Promise.all([
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
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				productCost: products.unitCost,
				markedCritical: products.critical,
				minStock: products.minStock,
				supplierSku: productSuppliers.supplierSku,
				cost: productSuppliers.cost,
				minimumQuantity: productSuppliers.minimumQuantity,
				unit: productSuppliers.unit,
				packSize: productSuppliers.packSize,
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
	]);
	const ranks = velocityRanks(planned.forecasts);

	return rows.map((p) => {
		const abcClass = planned.abc.classes.get(p.productId)?.abc ?? null;
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
			supplier && p.unit !== null && p.packSize !== null
				? {
						unit: p.unit,
						packSize: p.packSize,
						minimumQuantity: p.minimumQuantity ?? 1,
					}
				: null;
		const stock = {
			sold: sold.get(p.productId) ?? 0,
			onHand: onHand.get(p.productId) ?? 0,
			onOrder: onOrder.get(p.productId) ?? 0,
		};
		const terms = purchase ?? { unit: "EACH", packSize: 1, minimumQuantity: 1 };
		const input: ReorderInput = {
			...stock,
			...planFor(planned, p.productId, p.supplierId),
			coverDays: p.coverDays ?? DEFAULT_COVER_DAYS,
			minStock: p.minStock ?? defaultMin,
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
			critical: isCritical(p.markedCritical, abcClass),
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
		});
		return { line, supplier, input, why };
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
	// Days until it would need ordering anyway.
	daysUntilReorder: number;
};

// A supplier's products that don't need ordering yet but will before its
// next PO would (within its cover days), soonest first, each at the top-up a
// reorder would order. Ordering them now saves a second shipment. Products
// in `except` (already on the draft) are left out.
export async function recommendedAdditions(
	db: Db,
	supplierId: number,
	except: Set<number>,
	now = new Date(),
): Promise<RecommendedLine[]> {
	const plans = await reorderBreakdown(db, { now });
	return plans
		.flatMap(({ line, supplier, input }): RecommendedLine[] => {
			if (supplier?.supplierId !== supplierId || except.has(line.productId))
				return [];
			const days = daysUntilReorder(input);
			const quantity = topUp(input);
			if (days === null || days > input.coverDays || quantity === 0) return [];
			return [{ ...line, quantity, daysUntilReorder: days }];
		})
		.sort((a, b) => a.daysUntilReorder - b.daysUntilReorder);
}

// What each supplier should be sent today. Computed fresh from sales, stock,
// and open POs rather than stored, so it never goes stale.
export async function suggestPurchases(
	db: Db,
	now = new Date(),
): Promise<SupplierSuggestion[]> {
	const [needs, drafts] = await Promise.all([
		reorderNeeds(db, now),
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
	} of needs) {
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
