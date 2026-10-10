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
import { type AbcClass, abcClasses } from "#/inventory/abc";
import { soldSince } from "#/inventory/sales";

// Sales from this many days back set each product's daily demand.
export const DEMAND_DAYS = 90;

// How many to order of one product, or 0 to leave it off the PO.
//
// A product needs ordering once what's on the shelf and on order would run out
// before a PO sent today arrives (leadTimeDays), with safetyDays to spare. It's
// then topped up to last coverDays past that, and to at least the supplier's
// minimum quantity. Oversold stock (negative onHand) is always bought back.
export function reorderQuantity(p: {
	dailyDemand: number;
	onHand: number;
	onOrder: number;
	leadTimeDays: number;
	safetyDays: number;
	coverDays: number;
	minimumQuantity: number;
}): number {
	const position = p.onHand + p.onOrder;
	const reorderPoint = p.dailyDemand * (p.leadTimeDays + p.safetyDays);
	if (position >= reorderPoint && position >= 0) return 0;
	const target = Math.ceil(
		p.dailyDemand * (p.leadTimeDays + p.safetyDays + p.coverDays),
	);
	const need = target - position;
	if (need <= 0) return 0;
	return Math.max(need, p.minimumQuantity);
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

// What each supplier should be sent today. Computed fresh from sales, stock,
// and open POs rather than stored, so it never goes stale.
export async function suggestPurchases(
	db: Db,
	now = new Date(),
): Promise<SupplierSuggestion[]> {
	const since = new Date(now.getTime() - DEMAND_DAYS * 86_400_000);
	const [sold, onHand, onOrder, linked, drafts, abc] = await Promise.all([
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
		db
			.select({ id: purchaseOrders.id, supplierId: purchaseOrders.supplierId })
			.from(purchaseOrders)
			.where(eq(purchaseOrders.status, "draft")),
		abcClasses(db, now),
	]);

	const bySupplier = new Map<number, SupplierSuggestion>();
	for (const p of linked) {
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
				abc.classes.get(p.productId)?.abc ?? null,
				p.leadTimeDays,
			),
			coverDays: p.coverDays,
			minimumQuantity: p.minimumQuantity,
		});
		if (quantity === 0) continue;

		let s = bySupplier.get(p.supplierId);
		if (!s) {
			s = {
				supplierId: p.supplierId,
				supplierName: p.supplierName,
				minimumOrder: p.minimumOrder,
				lines: [],
				total: 0,
				unpriced: 0,
				ready: false,
				draftId: drafts.find((d) => d.supplierId === p.supplierId)?.id ?? null,
			};
			bySupplier.set(p.supplierId, s);
		}
		// The supplier's price if we know it, else what we last valued it at.
		const unitCost = p.cost ?? p.productCost;
		s.lines.push({
			productId: p.productId,
			sku: p.sku,
			name: p.name,
			variantName: p.variantName,
			imageUrl: p.imageUrl,
			supplierSku: p.supplierSku,
			...line,
			quantity,
			unitCost,
		});
		if (unitCost === null) s.unpriced++;
		else s.total += quantity * unitCost;
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

// Units on sent POs that haven't arrived yet. Drafts aren't on order.
export async function unitsOnOrder(db: Db, productIds?: number[]) {
	const received = db
		.select({
			lineId: purchaseOrderReceipts.lineId,
			units: sql<number>`sum(${purchaseOrderReceipts.quantity})`.as("units"),
		})
		.from(purchaseOrderReceipts)
		.groupBy(purchaseOrderReceipts.lineId)
		.as("received");
	const rows = await db
		.select({
			productId: purchaseOrderLines.productId,
			units: sql<number>`sum(greatest(${purchaseOrderLines.quantity} - coalesce(${received.units}, 0), 0))::int`,
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

// A products that will run out before a PO sent today could arrive, counting
// what's already on order. Products without a supplier use the default lead
// time, since they still have to come from somewhere.
const DEFAULT_LEAD_TIME_DAYS = 14;
export async function aItemsAtRisk(db: Db, now = new Date()) {
	const since = new Date(now.getTime() - DEMAND_DAYS * 86_400_000);
	const [abc, sold, onHand, onOrder] = await Promise.all([
		abcClasses(db, now),
		soldSince(db, since, { includeFba: false }),
		ownedOnHand(db),
		unitsOnOrder(db),
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
			const position = (onHand.get(p.id) ?? 0) + (onOrder.get(p.id) ?? 0);
			const leadTimeDays = p.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
			if (position >= dailyDemand * leadTimeDays) return [];
			return [
				{
					sku: p.sku,
					name: p.name,
					variantName: p.variantName,
					imageUrl: p.imageUrl,
					// Days until the shelf and what's on order run out.
					daysLeft: Math.max(0, Math.floor(position / dailyDemand)),
					leadTimeDays,
				},
			];
		})
		.sort((a, b) => a.daysLeft - b.daysLeft);
}
