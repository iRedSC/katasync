import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { lineAwaitsMatch } from "#/channels/unmatched";
import { getDb } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	orderCharges,
	orderCostChecks,
	orderCostReports,
	orderLines,
	orderProfit,
	orderReturns,
	orderReturnsDue,
	orders,
	products,
	type ReturnState,
	returnRequests,
	shipments,
	stores,
} from "#/db/schema";
import { adminUrls } from "#/orders/admin-urls";
import { fromStore } from "#/orders/from-store";
import { returnStages } from "#/orders/return-stage";
import { labelToVoid, needsShipping } from "#/orders/to-ship";

export const countOrdersToShip = createServerFn({ method: "GET" }).handler(
	async () => {
		const [{ count }] = await getDb()
			.select({ count: sql<number>`count(*)::int` })
			.from(orders)
			.where(needsShipping);
		return count;
	},
);

export const listOrders = createServerFn({ method: "GET" })
	.validator(type({ view: "'ship' | 'all'" }))
	.handler(async ({ data }) => {
		const scope =
			data.view === "ship" ? or(needsShipping, labelToVoid) : undefined;
		const lineStats = getDb()
			.select({
				orderId: orderLines.orderId,
				items: sql<number>`sum(${orderLines.quantity})::int`.as("items"),
				// Lines from a listing still waiting for its product. Custom items
				// have no listing and are never matched.
				unmatched:
					sql<number>`count(*) filter (where ${lineAwaitsMatch({ productId: orderLines.productId, storeId: orders.storeId, listingExternalId: orderLines.listingExternalId })})::int`.as(
						"unmatched",
					),
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.groupBy(orderLines.orderId)
			.as("line_stats");
		const listed = await getDb()
			.select({
				id: orders.id,
				name: orders.name,
				pin: orders.pin,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				externalId: orders.externalId,
				placedAt: orders.placedAt,
				cancelledAt: orders.cancelledAt,
				fulfillmentStatus: orders.fulfillmentStatus,
				financialStatus: orders.financialStatus,
				customerName: orders.customerName,
				shipCity: orders.shipCity,
				shipCountry: orders.shipCountry,
				shipRegion: orders.shipRegion,
				total: orders.total,
				store: stores.name,
				channel: stores.channel,
				items: sql<number>`coalesce(${lineStats.items}, 0)`,
				unmatched: sql<number>`coalesce(${lineStats.unmatched}, 0)`,
				labelToVoid,
				fulfilledByChannel: orders.fulfilledByChannel,
				invoicePrintedAt: orders.invoicePrintedAt,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.leftJoin(lineStats, eq(lineStats.orderId, orders.id))
			// A cancelled order with a live label stays in view until it's voided.
			.where(scope)
			.orderBy(desc(orders.placedAt))
			.limit(data.view === "ship" ? 500 : 200);
		// Each order's lines, for its products column and the search. The title
		// is the marketplace's, as on the order page; the photo is katasync's.
		const lines = await getDb()
			.select({
				orderId: orderLines.orderId,
				id: orderLines.id,
				title: orderLines.title,
				sku: orderLines.sku,
				quantity: orderLines.quantity,
				productSku: products.sku,
				productName: products.name,
				imageUrl: products.imageUrl,
				fromStore,
			})
			.from(orderLines)
			.leftJoin(products, eq(products.id, orderLines.productId))
			.where(
				inArray(
					orderLines.orderId,
					listed.map((o) => o.id),
				),
			)
			.orderBy(orderLines.id);
		const linesOf = new Map<
			number,
			Omit<(typeof lines)[number], "orderId">[]
		>();
		for (const { orderId, ...line } of lines) {
			linesOf.set(orderId, [...(linesOf.get(orderId) ?? []), line]);
		}
		// How many the view holds, so the list can say when it's cut short.
		const [{ total }] = await getDb()
			.select({ total: sql<number>`count(*)::int` })
			.from(orders)
			.where(scope);
		const stages = await returnStages(
			getDb(),
			listed.map((o) => o.id),
		);
		return {
			orders: listed.map((o) => ({
				...o,
				returnStage: stages.get(o.id) ?? null,
				lines: linesOf.get(o.id) ?? [],
			})),
			total,
		};
	});

export const getOrder = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [order] = await db
			.select({
				id: orders.id,
				name: orders.name,
				pin: orders.pin,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				placedAt: orders.placedAt,
				cancelledAt: orders.cancelledAt,
				fulfillmentStatus: orders.fulfillmentStatus,
				fulfilledByChannel: orders.fulfilledByChannel,
				financialStatus: orders.financialStatus,
				customerName: orders.customerName,
				shipAddress1: orders.shipAddress1,
				shipAddress2: orders.shipAddress2,
				shipCity: orders.shipCity,
				shipRegion: orders.shipRegion,
				shipPostalCode: orders.shipPostalCode,
				shipCountry: orders.shipCountry,
				shipPhone: orders.shipPhone,
				total: orders.total,
				shippingCharged: orders.shippingCharged,
				externalId: orders.externalId,
				store: stores.name,
				channel: stores.channel,
				labelToVoid,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(eq(orders.id, data.id));
		if (!order) throw new Error(`No order ${data.id}`);
		const lines = await db
			.select({
				id: orderLines.id,
				title: orderLines.title,
				sku: orderLines.sku,
				quantity: orderLines.quantity,
				unitPrice: orderLines.unitPrice,
				unitCost: orderLines.unitCost,
				tookStock: sql<boolean>`${orderLines.saleBatchId} is not null`,
				fromStore,
				// Units received back, and how many of those went on the shelf.
				returned: sql<number>`coalesce((select sum(${orderReturns.quantity}) from ${orderReturns} where ${orderReturns.orderLineId} = ${orderLines.id}), 0)::int`,
				// Back on a shelf, as itself or as a refurb, or before cutover.
				restocked: sql<number>`coalesce((select sum(${orderReturns.quantity}) from ${orderReturns} where ${orderReturns.orderLineId} = ${orderLines.id} and (${orderReturns.restocked} or ${orderReturns.refurbProductId} is not null or ${orderReturns.preCutover})), 0)::int`,
				productSku: products.sku,
				productName: products.name,
				imageUrl: products.imageUrl,
				// Its listing has no product yet. Custom items have no listing.
				awaitsMatch: lineAwaitsMatch({
					productId: orderLines.productId,
					storeId: orders.storeId,
					listingExternalId: orderLines.listingExternalId,
				}),
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.leftJoin(products, eq(products.id, orderLines.productId))
			.where(eq(orderLines.orderId, data.id))
			.orderBy(orderLines.id);
		// Every dispatch this order went out in (or will): its boxes, this
		// order's tracking handoff, and any other orders in the same box.
		const handoffs = await db
			.select({
				dispatchId: dispatchOrders.dispatchId,
				channelSentAt: dispatchOrders.channelSentAt,
				channelError: dispatchOrders.channelError,
				channelRetryAt: dispatchOrders.channelRetryAt,
				reversedAt: dispatchOrders.reversedAt,
				boughtAt: dispatches.boughtAt,
			})
			.from(dispatchOrders)
			.innerJoin(dispatches, eq(dispatches.id, dispatchOrders.dispatchId))
			.where(eq(dispatchOrders.orderId, data.id))
			.orderBy(dispatchOrders.dispatchId);
		const ids = handoffs.map((h) => h.dispatchId);
		const boxes = ids.length
			? await db
					.select({
						id: shipments.id,
						dispatchId: shipments.dispatchId,
						serviceName: shipments.serviceName,
						cost: shipments.cost,
						trackingNumber: shipments.trackingNumber,
						trackingUrl: shipments.trackingUrl,
						provider: shipments.provider,
						test: shipments.test,
						voidedAt: shipments.voidedAt,
						refundStatus: shipments.refundStatus,
						storefrontTrackingError: shipments.storefrontTrackingError,
						createdAt: shipments.createdAt,
					})
					.from(shipments)
					.where(inArray(shipments.dispatchId, ids))
					.orderBy(shipments.id)
			: [];
		const others = ids.length
			? await db
					.select({
						dispatchId: dispatchOrders.dispatchId,
						id: orders.id,
						name: orders.name,
					})
					.from(dispatchOrders)
					.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
					.where(
						and(
							inArray(dispatchOrders.dispatchId, ids),
							ne(dispatchOrders.orderId, data.id),
						),
					)
					.orderBy(orders.id)
			: [];
		// A purchase whose first box failed leaves a dispatch with no boxes;
		// there's nothing to show for it.
		const sends = handoffs.flatMap((h) => {
			const own = boxes.filter((b) => b.dispatchId === h.dispatchId);
			if (own.length === 0) return [];
			return {
				id: h.dispatchId,
				channelSentAt: h.channelSentAt,
				channelError: h.channelError,
				// Still being sent again on its own (src/shipping/retry.ts).
				retrying: h.channelRetryAt !== null,
				// False when a box failed part way: void only, never send.
				complete: h.boughtAt !== null,
				// Voided, but taking it back for this order didn't finish.
				unfinishedVoid: h.reversedAt === null,
				boxes: own,
				live: own.some((b) => b.voidedAt === null),
				shippedWith: others.filter((o) => o.dispatchId === h.dispatchId),
			};
		});
		// What it made, and what each marketplace said it charged.
		const [[profit], charges, reports, checks, [due], requests, stages] =
			await Promise.all([
				db.select().from(orderProfit).where(eq(orderProfit.orderId, data.id)),
				db
					.select({
						billedBy: orderCharges.billedBy,
						kind: orderCharges.kind,
						description: orderCharges.description,
						amount: orderCharges.amount,
					})
					.from(orderCharges)
					.where(eq(orderCharges.orderId, data.id))
					.orderBy(orderCharges.id),
				db
					.select({
						billedBy: orderCostReports.billedBy,
						settled: orderCostReports.settled,
						fetchedAt: orderCostReports.fetchedAt,
					})
					.from(orderCostReports)
					.where(eq(orderCostReports.orderId, data.id)),
				db
					.select({
						billedBy: orderCostChecks.billedBy,
						checkedAt: orderCostChecks.checkedAt,
						error: orderCostChecks.error,
					})
					.from(orderCostChecks)
					.where(eq(orderCostChecks.orderId, data.id)),
				// What's due back, as the Returns tab has it.
				db
					.select({ state: orderReturnsDue.state })
					.from(orderReturnsDue)
					.where(eq(orderReturnsDue.orderId, data.id))
					.limit(1),
				db
					.select({
						billedBy: returnRequests.billedBy,
						status: returnRequests.status,
						rawStatus: returnRequests.rawStatus,
						reason: returnRequests.reason,
						trackingNumber: returnRequests.trackingNumber,
						carrier: returnRequests.carrier,
						requestedAt: returnRequests.requestedAt,
					})
					.from(returnRequests)
					.where(eq(returnRequests.orderId, data.id))
					.orderBy(desc(returnRequests.requestedAt)),
				returnStages(db, [data.id]),
			]);
		return {
			order: { ...order, returnStage: stages.get(data.id) ?? null },
			lines,
			sends,
			// Amazon orders already link there to fulfill.
			adminUrls: adminUrls(order).filter((p) => p.channel !== "amazon"),
			profit: profit ?? null,
			charges,
			reports,
			checks,
			returnState: (due?.state ?? null) as ReturnState | null,
			returnRequests: requests,
		};
	});

export { listInvoices, markInvoicesPrinted } from "./orders/invoices";
// Split out by what they serve; kept here so callers import one place.
export {
	getRefurbishOptions,
	getReturns,
	markOrderNoReturn,
	type ReturnsData,
	receiveOrderReturn,
	refurbishOrderReturn,
	searchReturnable,
	undoOrderNoReturn,
	undoOrderReturn,
} from "./orders/returns";

export type OrderRow = Awaited<ReturnType<typeof listOrders>>["orders"][number];
export type OrderDetail = Awaited<ReturnType<typeof getOrder>>;
