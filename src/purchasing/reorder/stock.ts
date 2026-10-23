import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productComponents,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	stockLevels,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { isOurs } from "#/inventory/locations";
import { carried } from "#/products/archive";
import { demandWindow, type LeadTime, setsSoldIn } from "#/purchasing/forecast";
import {
	type SetMembership,
	type SetRecipeRow,
	setMembership,
} from "#/purchasing/sets";
import { DEFAULT_LEAD_TIME_DAYS, loadPlan, planFor } from "./plan";
import { type Arrival, incomingFor } from "./quantity";

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
	const [recipes, onHand, sold] = await Promise.all([
		setRecipes(db),
		ownedOnHand(db),
		setsSoldIn(db, demandWindow(now)),
	]);
	return setMembership(recipes, onHand, sold).get(productId) ?? null;
}

// On hand across our own locations, the retail store's included: the
// warehouse restocks it. Negative (oversold) stays negative, so it
// gets bought back.
const onHandBy = (db: Db) =>
	db
		.select({
			productId: stockLevels.productId,
			units: sql<number>`sum(${stockLevels.onHand})::int`.as("units"),
		})
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(isOurs)
		.groupBy(stockLevels.productId)
		.as("on_hand");

export async function ownedOnHand(db: Db) {
	const rows = await db.select().from(onHandBy(db));
	return new Map(rows.map((r) => [r.productId, r.units]));
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
const onOrderBy = (db: Db, productIds?: number[]) => {
	const received = receivedByLine(db);
	return db
		.select({
			productId: purchaseOrderLines.productId,
			units:
				sql<number>`sum(greatest(${purchaseOrderLines.quantity} - coalesce(${received.units}, 0), 0) * ${purchaseOrderLines.packSize})::int`.as(
					"units",
				),
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
		.groupBy(purchaseOrderLines.productId)
		.as("on_order");
};

export async function unitsOnOrder(db: Db, productIds?: number[]) {
	const rows = await db.select().from(onOrderBy(db, productIds));
	return new Map(rows.map((r) => [r.productId, r.units]));
}

// On hand and on order from one statement, so a receipt landing between two
// reads can't count in one and not the other: it's all before or all after.
export async function stockAndOrders(db: Db, productIds?: number[]) {
	const hand = onHandBy(db);
	const order = onOrderBy(db, productIds);
	const rows = await db
		.select({
			productId: sql<number>`coalesce(${hand.productId}, ${order.productId})`,
			// Both subqueries call their column units; a bare reference to
			// either would be ambiguous across the join.
			onHand: sql<number | null>`"on_hand"."units"`,
			onOrder: sql<number | null>`"on_order"."units"`,
		})
		.from(hand)
		.fullJoin(order, eq(order.productId, hand.productId));
	const onHand = new Map<number, number>();
	const onOrder = new Map<number, number>();
	for (const r of rows) {
		if (r.onHand !== null) onHand.set(r.productId, r.onHand);
		if (r.onOrder !== null) onOrder.set(r.productId, r.onOrder);
	}
	return { onHand, onOrder };
}

// Each product's line on an open draft. Suggestions keep a product to one
// draft (plannedFrom), but one added by hand can be on two; the newest wins.
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

// Unreceived units on sent POs, with their promised date or a lead-time estimate.
export async function openArrivals(
	db: Db,
	_now: Date,
	lead: Map<number, LeadTime>,
	productIds?: number[],
) {
	const received = receivedByLine(db);
	const rows = await db
		.select({
			productId: purchaseOrderLines.productId,
			units: sql<number>`(greatest(${purchaseOrderLines.quantity} - coalesce(${received.units}, 0), 0) * ${purchaseOrderLines.packSize})::int`,
			sentAt: purchaseOrders.sentAt,
			expectedAt: purchaseOrders.expectedAt,
			supplierId: purchaseOrders.supplierId,
			backOrderedAt: purchaseOrderLines.backOrderedAt,
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
		);

	const byProduct = new Map<number, Arrival[]>();
	for (const r of rows) {
		if (r.units === 0) continue;
		const arrivesAt =
			r.backOrderedAt !== null
				? null
				: (r.expectedAt?.getTime() ??
					(r.sentAt === null
						? null
						: r.sentAt.getTime() +
							(lead.get(r.supplierId)?.days ?? DEFAULT_LEAD_TIME_DAYS) *
								86_400_000));
		const list = byProduct.get(r.productId) ?? [];
		list.push({ units: r.units, arrivesAt });
		byProduct.set(r.productId, list);
	}
	return byProduct;
}

// A products that will run out before a PO sent today could arrive. Units on
// order only count if they land before the shelf empties. Products without a
// supplier use the default lead time, since they still have to come from
// somewhere.
export async function aItemsAtRisk(db: Db, now = new Date()) {
	const plan = await loadPlan(db, now);
	const [onHand, arrivals] = await Promise.all([
		ownedOnHand(db),
		openArrivals(db, now, plan.leadTimes),
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
		.leftJoin(
			supplierOffers,
			and(
				eq(supplierOffers.productId, products.id),
				eq(supplierOffers.cheapest, true),
			),
		)
		.leftJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
		// Not counted sells without limit, so it can't run out.
		.where(and(inArray(products.id, aIds), isNull(products.notCountedSince)));

	return rows
		.flatMap((p) => {
			const { dailyDemand, leadTimeDays } = planFor(plan, p.id, p.supplierId);
			if (dailyDemand === 0) return [];
			const { timely } = incomingFor(
				now.getTime(),
				onHand.get(p.id) ?? 0,
				dailyDemand,
				leadTimeDays,
				arrivals.get(p.id) ?? [],
			);
			const position = Math.max(onHand.get(p.id) ?? 0, 0) + timely;
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
