import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	orderLines,
	orders,
	productComponents,
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	stockLevels,
	suppliers,
} from "#/db/schema";

// Sales from this many days back set each product's daily demand.
export const DEMAND_DAYS = 90;

// How many of the supplier's unit to order, or 0 to leave it off the PO.
// Demand, stock, and what's on order count the product itself; packSize is how
// many of it one unit holds.
//
// A product needs ordering once what's on the shelf and on order would run out
// before a PO sent today arrives (leadTimeDays). It's then topped up to last
// coverDays past arrival, rounded up to whole units, and to at least the
// supplier's minimum. Oversold stock (negative onHand) is always bought back.
export function reorderQuantity(p: {
	dailyDemand: number;
	onHand: number;
	onOrder: number;
	leadTimeDays: number;
	coverDays: number;
	minimumQuantity: number;
	packSize: number;
}): number {
	const position = p.onHand + p.onOrder;
	const reorderPoint = p.dailyDemand * p.leadTimeDays;
	if (position >= reorderPoint && position >= 0) return 0;
	const target = Math.ceil(p.dailyDemand * (p.leadTimeDays + p.coverDays));
	const need = target - position;
	if (need <= 0) return 0;
	return Math.max(Math.ceil(need / p.packSize), p.minimumQuantity);
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
	const [sold, onHand, onOrder, linked, drafts] = await Promise.all([
		soldSince(db, since),
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
		db
			.select({ id: purchaseOrders.id, supplierId: purchaseOrders.supplierId })
			.from(purchaseOrders)
			.where(eq(purchaseOrders.status, "draft")),
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
			coverDays: p.coverDays,
			minimumQuantity: p.minimumQuantity,
			packSize: p.packSize,
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
		const unitCost =
			p.cost ?? (p.productCost === null ? null : p.productCost * p.packSize);
		s.lines.push({
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

// Units sold per stocked product since a date. Tool sets count as their parts,
// since that's what leaves the shelf. Amazon's own (FBA) shipments are left
// out: they never take our stock.
async function soldSince(db: Db, since: Date) {
	const rows = await db
		.select({
			productId: sql<number>`coalesce(${productComponents.componentProductId}, ${orderLines.productId})`,
			units: sql<number>`sum(${orderLines.quantity} * coalesce(${productComponents.quantity}, 1))::int`,
		})
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.innerJoin(products, eq(products.id, orderLines.productId))
		.leftJoin(
			productComponents,
			and(
				eq(productComponents.parentProductId, orderLines.productId),
				eq(products.kind, "bundle"),
			),
		)
		.where(
			and(
				gte(orders.placedAt, since),
				isNull(orders.cancelledAt),
				eq(orders.fulfilledByChannel, false),
			),
		)
		.groupBy(sql`1`);
	return new Map(rows.map((r) => [r.productId, r.units]));
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

// How many of each product are on sent POs and haven't arrived yet, counting
// the product itself (2 cases of 30 is 60). Drafts aren't on order.
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
