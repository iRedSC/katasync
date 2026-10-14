import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	stockLevels,
	suppliers,
} from "#/db/schema";
import { type AbcClass, type AbcResult, abcClasses } from "#/inventory/abc";
import { soldSince } from "#/inventory/sales";

// Sales from this many days back set each product's daily demand.
export const DEMAND_DAYS = 90;

// How many of the supplier's unit to order, or 0 to leave it off the PO.
// Demand, stock, and what's on order count the product itself; packSize is how
// many of it one unit holds.
//
// A product needs ordering once what's on the shelf and on order would run out
// before a PO sent today arrives (leadTimeDays), with safetyDays to spare. It's
// then topped up to last coverDays past that, rounded up to whole units, and to
// at least the supplier's minimum. Oversold stock (negative onHand) is always
// bought back.
export function reorderQuantity(p: {
	dailyDemand: number;
	onHand: number;
	onOrder: number;
	leadTimeDays: number;
	safetyDays: number;
	coverDays: number;
	minimumQuantity: number;
	packSize: number;
}): number {
	const position = p.onHand + p.onOrder;
	const reorderPoint = p.dailyDemand * (p.leadTimeDays + p.safetyDays);
	if (position >= reorderPoint && position >= 0) return 0;
	const target = Math.ceil(
		p.dailyDemand * (p.leadTimeDays + p.safetyDays + p.coverDays),
	);
	const need = target - position;
	if (need <= 0) return 0;
	return Math.max(Math.ceil(need / p.packSize), p.minimumQuantity);
}

// A items carry this share of their lead time as spare stock, since running
// out of them costs the most. B and C carry none.
const A_SAFETY = 0.5;
export const safetyDays = (abc: AbcClass | null, leadTimeDays: number) =>
	abc === "A" ? Math.ceil(leadTimeDays * A_SAFETY) : 0;

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
};

export type SupplierSuggestion = {
	supplierId: number;
	supplierName: string;
	minimumOrder: number;
	lines: SuggestedLine[];
	// Lines without a price add nothing here.
	total: number;
	unpriced: number;
	// The total reached the supplier's minimum order.
	ready: boolean;
	draftId: number | null;
};

// One product that needs ordering, with the supplier it comes from.
export type ReorderNeed = SuggestedLine & {
	supplierId: number;
	supplierName: string;
	minimumOrder: number;
};

// Every product with a supplier that needs ordering today, in name order.
// Pass `abc` when the caller already has it, to skip ranking twice.
export async function reorderNeeds(
	db: Db,
	now = new Date(),
	abc?: AbcResult,
): Promise<ReorderNeed[]> {
	const since = new Date(now.getTime() - DEMAND_DAYS * 86_400_000);
	const [sold, onHand, onOrder, linked, classes] = await Promise.all([
		soldSince(db, since, { includeFba: false }),
		ownedOnHand(db),
		unitsOnOrder(db),
		db
			.select({
				productId: products.id,
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				productCost: products.unitCost,
				supplierSku: productSuppliers.supplierSku,
				cost: productSuppliers.cost,
				minimumQuantity: productSuppliers.minimumQuantity,
				unit: productSuppliers.unit,
				packSize: productSuppliers.packSize,
				supplierId: suppliers.id,
				supplierName: suppliers.name,
				leadTimeDays: suppliers.leadTimeDays,
				coverDays: suppliers.coverDays,
				minimumOrder: suppliers.minimumOrder,
			})
			.from(productSuppliers)
			.innerJoin(products, eq(products.id, productSuppliers.productId))
			.innerJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
			.orderBy(products.name, products.variantName),
		abc ?? abcClasses(db, now),
	]);

	return linked.flatMap((p) => {
		const line = {
			sold: sold.get(p.productId) ?? 0,
			onHand: onHand.get(p.productId) ?? 0,
			onOrder: onOrder.get(p.productId) ?? 0,
		};
		const quantity = reorderQuantity({
			...line,
			dailyDemand: line.sold / DEMAND_DAYS,
			leadTimeDays: p.leadTimeDays,
			safetyDays: safetyDays(
				classes.classes.get(p.productId)?.abc ?? null,
				p.leadTimeDays,
			),
			coverDays: p.coverDays,
			minimumQuantity: p.minimumQuantity,
			packSize: p.packSize,
		});
		if (quantity === 0) return [];
		return [
			{
				productId: p.productId,
				sku: p.sku,
				name: p.name,
				variantName: p.variantName,
				imageUrl: p.imageUrl,
				supplierSku: p.supplierSku,
				unit: p.unit,
				packSize: p.packSize,
				minimumQuantity: p.minimumQuantity,
				...line,
				quantity,
				// The supplier's price if we know it, else what we last valued it at.
				unitCost:
					p.cost ??
					(p.productCost === null ? null : p.productCost * p.packSize),
				supplierId: p.supplierId,
				supplierName: p.supplierName,
				minimumOrder: p.minimumOrder,
			},
		];
	});
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
	for (const { supplierId, supplierName, minimumOrder, ...line } of needs) {
		let s = bySupplier.get(supplierId);
		if (!s) {
			s = {
				supplierId,
				supplierName,
				minimumOrder,
				lines: [],
				total: 0,
				unpriced: 0,
				ready: false,
				draftId: drafts.find((d) => d.supplierId === supplierId)?.id ?? null,
			};
			bySupplier.set(supplierId, s);
		}
		s.lines.push(line);
		if (line.unitCost === null) s.unpriced++;
		else s.total += line.quantity * line.unitCost;
	}

	const result = [...bySupplier.values()];
	for (const s of result) {
		s.total = Math.round(s.total * 100) / 100;
		s.ready = s.total >= s.minimumOrder;
	}
	// Ready first, then the biggest orders.
	return result.sort(
		(a, b) => Number(b.ready) - Number(a.ready) || b.total - a.total,
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
async function arrivingUnits(db: Db, now: Date) {
	const received = receivedByLine(db);
	const rows = await db
		.select({
			productId: purchaseOrderLines.productId,
			units: sql<number>`(greatest(${purchaseOrderLines.quantity} - coalesce(${received.units}, 0), 0) * ${purchaseOrderLines.packSize})::int`,
			expectedAt: purchaseOrders.expectedAt,
			sentAt: purchaseOrders.sentAt,
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
			(r.sentAt ?? now).getTime() + r.leadTimeDays * 86_400_000;
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
const DEFAULT_LEAD_TIME_DAYS = 14;
export async function aItemsAtRisk(db: Db, now = new Date()) {
	const since = new Date(now.getTime() - DEMAND_DAYS * 86_400_000);
	const [abc, sold, onHand, arriving] = await Promise.all([
		abcClasses(db, now),
		soldSince(db, since, { includeFba: false }),
		ownedOnHand(db),
		arrivingUnits(db, now),
	]);
	const aIds = [...abc.classes]
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
			leadTimeDays: suppliers.leadTimeDays,
		})
		.from(products)
		.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
		.leftJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
		.where(inArray(products.id, aIds));

	return rows
		.flatMap((p) => {
			const dailyDemand = (sold.get(p.id) ?? 0) / DEMAND_DAYS;
			if (dailyDemand === 0) return [];
			// Each PO extends the stock only if it arrives before it runs out.
			let position = onHand.get(p.id) ?? 0;
			for (const po of arriving.get(p.id) ?? []) {
				const daysAway = (po.arrivesAt - now.getTime()) / 86_400_000;
				if (daysAway * dailyDemand > position) break;
				position += po.units;
			}
			const leadTimeDays = p.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
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
