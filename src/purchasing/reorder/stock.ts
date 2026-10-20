import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productComponents,
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	stockLevels,
	suppliers,
} from "#/db/schema";
import { setsSoldSince } from "#/inventory/sales";
import { carried } from "#/products/archive";
import { DEMAND_DAYS, type LeadTime } from "#/purchasing/forecast";
import {
	type SetMembership,
	type SetRecipeRow,
	setMembership,
} from "#/purchasing/sets";
import { loadPlan, planFor } from "./plan";

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
		.where(and(eq(products.kind, "bundle"), carried));
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
export async function ownedOnHand(db: Db) {
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
		// Not counted sells without limit, so it can't run out.
		.where(and(inArray(products.id, aIds), isNull(products.notCountedSince)));

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
