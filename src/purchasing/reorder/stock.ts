import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productComponents,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	stockLevels,
} from "#/db/schema";
import { isOurs } from "#/inventory/locations";
import { carried } from "#/products/archive";
import { demandWindow, type LeadTime, setsSoldIn } from "#/purchasing/forecast";
import {
	type SetMembership,
	type SetRecipeRow,
	setMembership,
} from "#/purchasing/sets";
import { DEFAULT_LEAD_TIME_DAYS } from "./plan";
import type { Arrival } from "./quantity";

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
function arrivalRows(db: Db, productIds?: number[]) {
	const received = receivedByLine(db);
	return db
		.select({
			productId: purchaseOrderLines.productId,
			units:
				sql<number>`(greatest(${purchaseOrderLines.quantity} - coalesce(${received.units}, 0), 0) * ${purchaseOrderLines.packSize})::int`.as(
					"units",
				),
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
}

type ArrivalRow = Awaited<ReturnType<typeof arrivalRows>>[number];

function datedArrivals(rows: ArrivalRow[], lead: Map<number, LeadTime>) {
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

export async function openArrivals(
	db: Db,
	_now: Date,
	lead: Map<number, LeadTime>,
	productIds?: number[],
) {
	return datedArrivals(await arrivalRows(db, productIds), lead);
}

export async function stockAndArrivals(
	db: Db,
	lead: Map<number, LeadTime>,
	productIds?: number[],
) {
	const hand = onHandBy(db);
	const incoming = arrivalRows(db, productIds).as("arrivals");
	const rows = await db
		.select({
			productId: sql<number>`coalesce(${hand.productId}, ${incoming.productId})`,
			onHand: sql<number | null>`"on_hand"."units"`,
			arrival: {
				productId: incoming.productId,
				units: sql<number>`"arrivals"."units"`,
				sentAt: incoming.sentAt,
				expectedAt: incoming.expectedAt,
				supplierId: incoming.supplierId,
				backOrderedAt: incoming.backOrderedAt,
			},
		})
		.from(hand)
		.fullJoin(incoming, eq(incoming.productId, hand.productId));
	const onHand = new Map<number, number>();
	const onOrder = new Map<number, number>();
	const arrivals: ArrivalRow[] = [];
	for (const row of rows) {
		if (row.onHand !== null) onHand.set(row.productId, row.onHand);
		if (row.arrival !== null) {
			onOrder.set(
				row.productId,
				(onOrder.get(row.productId) ?? 0) + row.arrival.units,
			);
			arrivals.push(row.arrival);
		}
	}
	return { onHand, onOrder, arrivals: datedArrivals(arrivals, lead) };
}
