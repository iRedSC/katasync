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

// Every product with a supplier, as reorder sees it today, in name order.
// Pass `plan` when the caller already has one, to skip loading it twice.
async function reorderPlans(db: Db, now: Date, plan?: Plan | Promise<Plan>) {
	const since = new Date(now.getTime() - DEMAND_DAYS * 86_400_000);
	const [sold, onHand, onOrder, defaultMin, linked, planned] =
		await Promise.all([
			soldSince(db, since, { includeFba: false }),
			ownedOnHand(db),
			unitsOnOrder(db),
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
				.from(productSuppliers)
				.innerJoin(products, eq(products.id, productSuppliers.productId))
				.innerJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
				.orderBy(products.name, products.variantName),
			plan ?? loadPlan(db, now),
		]);

	return linked.map((p) => {
		const abcClass = planned.abc.classes.get(p.productId)?.abc ?? null;
		const stock = {
			sold: sold.get(p.productId) ?? 0,
			onHand: onHand.get(p.productId) ?? 0,
			onOrder: onOrder.get(p.productId) ?? 0,
		};
		const input: ReorderInput = {
			...stock,
			...planFor(planned, p.productId, p.supplierId),
			coverDays: p.coverDays,
			minStock: p.minStock ?? defaultMin,
			minimumQuantity: p.minimumQuantity,
			packSize: p.packSize,
		};
		const need: ReorderNeed = {
			productId: p.productId,
			sku: p.sku,
			name: p.name,
			variantName: p.variantName,
			imageUrl: p.imageUrl,
			supplierSku: p.supplierSku,
			unit: p.unit,
			packSize: p.packSize,
			minimumQuantity: p.minimumQuantity,
			...stock,
			quantity: reorderQuantity(input),
			// The supplier's price if we know it, else what we last valued it at.
			unitCost:
				p.cost ?? (p.productCost === null ? null : p.productCost * p.packSize),
			critical: isCritical(p.markedCritical, abcClass),
			supplierId: p.supplierId,
			supplierName: p.supplierName,
			minimumOrder: p.minimumOrder,
			criticalThreshold: p.criticalThreshold,
		};
		return { need, input };
	});
}

// Every product with a supplier that needs ordering today, in name order.
// Pass `plan` when the caller already has one, to skip loading it twice.
export async function reorderNeeds(
	db: Db,
	now = new Date(),
	plan?: Plan | Promise<Plan>,
): Promise<ReorderNeed[]> {
	const plans = await reorderPlans(db, now, plan);
	return plans.flatMap(({ need }) => (need.quantity > 0 ? [need] : []));
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
	const plans = await reorderPlans(db, now);
	return plans
		.flatMap(({ need, input }): RecommendedLine[] => {
			if (need.supplierId !== supplierId || except.has(need.productId))
				return [];
			const days = daysUntilReorder(input);
			const quantity = topUp(input);
			if (days === null || days > input.coverDays || quantity === 0) return [];
			return [{ ...suggestedLine(need), quantity, daysUntilReorder: days }];
		})
		.sort((a, b) => a.daysUntilReorder - b.daysUntilReorder);
}

// A need without its supplier's fields.
function suggestedLine({
	supplierId: _,
	supplierName: __,
	minimumOrder: ___,
	criticalThreshold: ____,
	...line
}: ReorderNeed): SuggestedLine {
	return line;
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
