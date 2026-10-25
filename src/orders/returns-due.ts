import {
	and,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	isNull,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import {
	orderLines,
	orderProfit,
	orderReturns,
	orderReturnsDue,
	orders,
	products,
	type ReturnState,
	returnRequestLines,
	returnRequests,
	returnTracking,
	stores,
} from "#/db/schema";
import { onBench } from "#/repairs/bench-holds";
import { returnPage } from "./admin-urls";
import { committedStock, returnQuantity } from "./return-stock";
import { type PackageAt, trackingFor } from "./return-tracking";
import { isLabeled, returnBlocker } from "./status";

// What the Returns & refunds tab shows: refunds waiting on our answer,
// orders with something due back (rules in the order_returns_due view), and
// what came back lately.

export type ReturnOrder = {
	id: number;
	name: string;
	channel: (typeof stores.$inferSelect)["channel"];
	salesChannel: string | null;
	marketplaceOrderId: string | null;
	externalId: string;
	customerName: string | null;
	shipCity: string | null;
	shipRegion: string | null;
	shipPostalCode: string | null;
	placedAt: Date;
	// Null for an order found by search with nothing expected.
	state: ReturnState | null;
	// Why its return can't be received here, if it can't.
	blocker: string | null;
	requests: {
		status: (typeof returnRequests.$inferSelect)["status"];
		reason: string | null;
		trackingNumber: string | null;
		carrier: string | null;
		requestedAt: Date;
		// Where its package is, as Shippo last said; null until asked.
		tracking: PackageAt | null;
	}[];
	// Items an open request names that no line matched, so which line
	// they are is decided when the box is opened.
	unmatched: { sku: string | null; quantity: number }[];
	lines: {
		id: number;
		title: string;
		sku: string | null;
		imageUrl: string | null;
		// Sold minus already received.
		left: number;
		expected: number;
	}[];
};

// A marketplace return still waiting on the buyer or on us. A refund is
// never due back: nothing's coming.
const openReturn = and(
	eq(returnRequests.kind, "return"),
	inArray(returnRequests.status, ["requested", "shipped", "delivered"]),
);

const stateOrder: ReturnState[] = [
	"on_its_way",
	"requested",
	"refunded",
	"maybe",
];

export async function listReturns(db: Db) {
	const due = await db.select().from(orderReturnsDue);
	const expected = new Map(due.map((d) => [d.lineId, d.expected]));
	const states = new Map(due.map((d) => [d.orderId, d.state]));
	const found = await returnOrders(db, [...states.keys()], states, expected);
	found.sort(
		(a, b) =>
			stateOrder.indexOf(a.state ?? "maybe") -
				stateOrder.indexOf(b.state ?? "maybe") ||
			a.placedAt.getTime() - b.placedAt.getTime(),
	);
	const [refunds, received] = await Promise.all([
		refundsToAnswer(db),
		recentlyReceived(db),
	]);
	return { refunds, due: found, received };
}

// Orders matching what's on the box (order number, buyer, city or postal
// code, SKU or product, return tracking) that can take a return but aren't
// due, for the box that arrives before anything said it would.
export async function findReturnable(db: Db, query: string) {
	const q = query.trim().replace(/^#/, "");
	if (q.length < 3) return [];
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const hits = await db
		.selectDistinct({ id: orders.id, placedAt: orders.placedAt })
		.from(orders)
		.leftJoin(orderLines, eq(orderLines.orderId, orders.id))
		.leftJoin(products, eq(products.id, orderLines.productId))
		.leftJoin(returnRequests, eq(returnRequests.orderId, orders.id))
		.where(
			and(
				isNull(orders.cancelledAt),
				eq(orders.fulfilledByChannel, false),
				notExists(
					db
						.select({ one: sql`1` })
						.from(orderReturnsDue)
						.where(eq(orderReturnsDue.orderId, orders.id)),
				),
				or(
					ilike(orders.name, like),
					ilike(orders.externalId, like),
					ilike(orders.marketplaceOrderId, like),
					ilike(orders.customerName, like),
					ilike(orders.shipCity, like),
					ilike(orders.shipPostalCode, like),
					ilike(orderLines.sku, like),
					ilike(orderLines.title, like),
					ilike(products.sku, like),
					ilike(products.name, like),
					ilike(returnRequests.trackingNumber, like),
				),
			),
		)
		.orderBy(desc(orders.placedAt))
		.limit(30);
	const found = await returnOrders(
		db,
		hits.map((h) => h.id),
		new Map(),
		new Map(),
	);
	return found
		.filter((o) => o.blocker === null && o.lines.length > 0)
		.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())
		.slice(0, 10);
}

async function returnOrders(
	db: Db,
	ids: number[],
	states: Map<number, ReturnState>,
	expected: Map<number, number>,
): Promise<ReturnOrder[]> {
	if (ids.length === 0) return [];
	const open = openReturn;
	const [found, lines, requests, unmatched] = await Promise.all([
		db
			.select({
				id: orders.id,
				name: orders.name,
				channel: stores.channel,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				externalId: orders.externalId,
				customerName: orders.customerName,
				shipCity: orders.shipCity,
				shipRegion: orders.shipRegion,
				shipPostalCode: orders.shipPostalCode,
				placedAt: orders.placedAt,
				cancelledAt: orders.cancelledAt,
				fulfilledByChannel: orders.fulfilledByChannel,
				fulfillmentStatus: orders.fulfillmentStatus,
				labelsStatus: orderProfit.labelsStatus,
				committedStock,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.leftJoin(orderProfit, eq(orderProfit.orderId, orders.id))
			.where(inArray(orders.id, ids)),
		db
			.select({
				id: orderLines.id,
				orderId: orderLines.orderId,
				title: orderLines.title,
				sku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
				imageUrl: products.imageUrl,
				left: sql<number>`${returnQuantity} - coalesce((select sum(${orderReturns.quantity}) from ${orderReturns} where ${orderReturns.orderLineId} = ${orderLines.id}), 0)::int - ${onBench()}`,
			})
			.from(orderLines)
			.leftJoin(products, eq(products.id, orderLines.productId))
			.where(inArray(orderLines.orderId, ids))
			.orderBy(orderLines.id),
		db
			.select({
				orderId: returnRequests.orderId,
				status: returnRequests.status,
				reason: returnRequests.reason,
				trackingNumber: returnRequests.trackingNumber,
				carrier: returnRequests.carrier,
				requestedAt: returnRequests.requestedAt,
				saved: {
					number: returnTracking.number,
					status: returnTracking.status,
					statusAt: returnTracking.statusAt,
					eta: returnTracking.eta,
				},
			})
			.from(returnRequests)
			.leftJoin(
				returnTracking,
				eq(returnTracking.returnRequestId, returnRequests.id),
			)
			.where(and(inArray(returnRequests.orderId, ids), open))
			.orderBy(desc(returnRequests.requestedAt)),
		db
			.select({
				orderId: returnRequests.orderId,
				sku: returnRequestLines.sku,
				quantity: returnRequestLines.quantity,
			})
			.from(returnRequestLines)
			.innerJoin(
				returnRequests,
				eq(returnRequests.id, returnRequestLines.requestId),
			)
			.where(
				and(
					inArray(returnRequests.orderId, ids),
					open,
					isNull(returnRequestLines.orderLineId),
				),
			)
			.orderBy(returnRequestLines.id),
	]);
	return found.map(
		({ cancelledAt, fulfilledByChannel, labelsStatus, ...o }) => ({
			...o,
			state: states.get(o.id) ?? null,
			blocker: returnBlocker({
				...o,
				cancelledAt,
				fulfilledByChannel,
				labeled: isLabeled(labelsStatus ?? undefined),
				shippedQuantity: o.committedStock
					? lines
							.filter((line) => line.orderId === o.id)
							.reduce((total, line) => total + Math.max(0, line.left), 0)
					: undefined,
			}),
			requests: requests
				.filter((r) => r.orderId === o.id)
				.map(({ orderId: _, saved, ...r }) => {
					const t = trackingFor(r.trackingNumber, saved);
					return {
						...r,
						tracking: t && {
							status: t.status,
							statusAt: t.statusAt,
							eta: t.eta,
						},
					};
				}),
			unmatched: unmatched
				.filter((u) => u.orderId === o.id)
				.map(({ orderId: _, ...u }) => u),
			lines: lines
				.filter((l) => l.orderId === o.id && l.left > 0)
				.map(({ orderId: _, ...l }) => ({
					...l,
					expected: expected.get(l.id) ?? 0,
				})),
		}),
	);
}

export type RefundRequest = Awaited<ReturnType<typeof refundsToAnswer>>[number];

// Refunds a buyer asked for with nothing coming back, waiting on our answer
// on the marketplace, oldest first: the nearest to its deadline.
async function refundsToAnswer(db: Db) {
	const rows = await db
		.select({
			id: returnRequests.id,
			orderId: orders.id,
			name: orders.name,
			channel: stores.channel,
			salesChannel: orders.salesChannel,
			externalId: orders.externalId,
			marketplaceOrderId: orders.marketplaceOrderId,
			customerName: orders.customerName,
			shipCity: orders.shipCity,
			shipRegion: orders.shipRegion,
			shipPostalCode: orders.shipPostalCode,
			placedAt: orders.placedAt,
			billedBy: returnRequests.billedBy,
			reason: returnRequests.reason,
			note: returnRequests.note,
			requestedAt: returnRequests.requestedAt,
		})
		.from(returnRequests)
		.innerJoin(orders, eq(orders.id, returnRequests.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(
			and(
				eq(returnRequests.kind, "refund"),
				eq(returnRequests.status, "requested"),
			),
		)
		.orderBy(returnRequests.requestedAt);
	const ids = rows.map((r) => r.id);
	const lines =
		ids.length > 0
			? await db
					.select({
						requestId: returnRequestLines.requestId,
						id: returnRequestLines.id,
						title: sql<string>`coalesce(${orderLines.title}, ${returnRequestLines.sku}, 'An item')`,
						sku: sql<
							string | null
						>`coalesce(${products.sku}, ${orderLines.sku}, ${returnRequestLines.sku})`,
						imageUrl: products.imageUrl,
						quantity: returnRequestLines.quantity,
					})
					.from(returnRequestLines)
					.leftJoin(
						orderLines,
						eq(orderLines.id, returnRequestLines.orderLineId),
					)
					.leftJoin(products, eq(products.id, orderLines.productId))
					.where(inArray(returnRequestLines.requestId, ids))
					.orderBy(returnRequestLines.id)
			: [];
	return rows.map(({ externalId, marketplaceOrderId, billedBy, ...r }) => ({
		...r,
		externalId,
		marketplaceOrderId,
		answerOn: returnPage(
			{ channel: r.channel, externalId, marketplaceOrderId },
			billedBy,
		),
		lines: lines
			.filter((l) => l.requestId === r.id)
			.map(({ requestId: _, ...l }) => l),
	}));
}

const refurbs = alias(products, "refurbs");

// Returns received in the last 30 days, newest first, one row per order and
// moment received. One whose order still has a return open on its
// marketplace links there to confirm it arrived, until a sync sees it closed:
// katasync doesn't tell marketplaces itself, since accepting a return can
// refund the buyer.
async function recentlyReceived(db: Db) {
	const rows = await db
		.select({
			id: orderReturns.id,
			orderId: orders.id,
			lineId: orderReturns.orderLineId,
			name: orders.name,
			channel: stores.channel,
			externalId: orders.externalId,
			marketplaceOrderId: orders.marketplaceOrderId,
			salesChannel: orders.salesChannel,
			customerName: orders.customerName,
			title: orderLines.title,
			sku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
			quantity: orderReturns.quantity,
			restocked: orderReturns.restocked,
			refurb: sql<{
				id: number;
				sku: string;
				condition: string;
			} | null>`case when ${refurbs.id} is null then null else json_build_object('id', ${refurbs.id}, 'sku', ${refurbs.sku}, 'condition', ${refurbs.condition}) end`,
			createdAt: orderReturns.createdAt,
		})
		.from(orderReturns)
		.leftJoin(refurbs, eq(refurbs.id, orderReturns.refurbProductId))
		.innerJoin(orderLines, eq(orderLines.id, orderReturns.orderLineId))
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.leftJoin(products, eq(products.id, orderLines.productId))
		// A pre-cutover return can't be received again as one, so it isn't
		// offered for taking back.
		.where(
			and(
				gte(orderReturns.createdAt, sql`now() - interval '30 days'`),
				eq(orderReturns.preCutover, false),
			),
		)
		.orderBy(desc(orderReturns.createdAt), orderReturns.id)
		.limit(200);
	const orderIds = [...new Set(rows.map((r) => r.orderId))];
	const open =
		orderIds.length > 0
			? await db
					.select({
						orderId: returnRequests.orderId,
						billedBy: returnRequests.billedBy,
					})
					.from(returnRequests)
					.where(and(inArray(returnRequests.orderId, orderIds), openReturn))
			: [];
	return rows.map(({ externalId, marketplaceOrderId, ...r }) => {
		const request = open.find((o) => o.orderId === r.orderId);
		return {
			...r,
			confirmOn: request
				? returnPage(
						{ channel: r.channel, externalId, marketplaceOrderId },
						request.billedBy,
					)
				: null,
		};
	});
}

export class NoReturnError extends Error {
	name = "NoReturnError";
}

// "Nothing coming back": a refund's items count as a cost at once and the
// order leaves Returns. Gives back what it replaced, for Undo.
export async function markNoReturn(db: Db, orderId: number) {
	return db.transaction(async (tx) => {
		const [order] = await tx
			.select({ noReturnAt: orders.noReturnAt })
			.from(orders)
			.where(eq(orders.id, orderId))
			.for("update");
		if (!order) throw new NoReturnError(`No order ${orderId}`);
		await tx
			.update(orders)
			.set({ noReturnAt: sql`now()` })
			.where(eq(orders.id, orderId));
		return { previous: order.noReturnAt };
	});
}

export async function restoreNoReturn(
	db: Db,
	orderId: number,
	previous: Date | null,
) {
	await db
		.update(orders)
		.set({ noReturnAt: previous })
		.where(eq(orders.id, orderId));
}
