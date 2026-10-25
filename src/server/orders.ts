import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { chatWay } from "#/buyers/chat-way";
import { orderSummary } from "#/buyers/order";
import { lineAwaitsMatch } from "#/channels/unmatched";
import { getDb } from "#/db/client";
import {
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
	returnRequestLines,
	returnRequests,
	returnTracking,
	stores,
} from "#/db/schema";
import { orderMail } from "#/inbox/order-mail";
import { adminUrls, returnPage } from "#/orders/admin-urls";
import { fromStore } from "#/orders/from-store";
import { returnStages } from "#/orders/return-stage";
import { committedStock, returnQuantity } from "#/orders/return-stock";
import { followReturn, trackingFor } from "#/orders/return-tracking";
import { stockEffectApplied } from "#/orders/stock-effects";
import { financialStatus, labelToVoid, needsShipping } from "#/orders/to-ship";
import { type SameBuyer, sameBuyerOrders } from "#/shipping/same-buyer";
import { sendsOf } from "#/shipping/sends";

const refurbs = alias(products, "refurbs");

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
				financialStatus,
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
		// One buyer's orders, to combine in TikTok before packing.
		const sameBuyer =
			data.view === "ship"
				? await sameBuyerOrders(getDb())
				: new Map<number, SameBuyer[]>();
		return {
			orders: listed.map((o) => ({
				...o,
				returnStage: stages.get(o.id) ?? null,
				lines: linesOf.get(o.id) ?? [],
				sameBuyer: sameBuyer.get(o.id) ?? [],
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
				committedStock,
				id: orders.id,
				name: orders.name,
				pin: orders.pin,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				placedAt: orders.placedAt,
				cancelledAt: orders.cancelledAt,
				fulfillmentStatus: orders.fulfillmentStatus,
				fulfilledByChannel: orders.fulfilledByChannel,
				financialStatus,
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
				soldInStore: orders.soldInStore,
				noReturnAt: orders.noReturnAt,
				invoicePrintedAt: orders.invoicePrintedAt,
				taxRemittedBy: orders.taxRemittedBy,
				sourceUpdatedAt: orders.sourceUpdatedAt,
				syncedAt: orders.syncedAt,
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
				returnQuantity,
				unitCost: orderLines.unitCost,
				tookStock: sql<boolean>`coalesce(${stockEffectApplied}, false)`,
				fromStore,
				// Units received back, and how many of those went on the shelf.
				returned: sql<number>`coalesce((select sum(${orderReturns.quantity}) from ${orderReturns} where ${orderReturns.orderLineId} = ${orderLines.id}), 0)::int`,
				// Back and on the bench, not received yet: their repairs.
				onBench: sql<
					number[]
				>`coalesce((select array_agg(b.id order by b.id) from repairs b where b.return_line_id = ${orderLines.id} and b.status::text in ('received', 'waiting_parts', 'in_repair', 'ready')), '{}')`,
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
		const sends = await sendsOf(db, data.id);
		// What it made, and what each marketplace said it charged; where its
		// return stands; the mail about it; and the buyer's other orders.
		const [
			[profit],
			charges,
			reports,
			checks,
			due,
			requests,
			requestLines,
			received,
			stages,
			mail,
			buyerOrders,
		] = await Promise.all([
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
			// What's due back, line by line, as the Returns tab has it.
			db
				.select({
					lineId: orderReturnsDue.lineId,
					state: orderReturnsDue.state,
					expected: orderReturnsDue.expected,
				})
				.from(orderReturnsDue)
				.where(eq(orderReturnsDue.orderId, data.id)),
			db
				.select({
					id: returnRequests.id,
					externalId: returnRequests.externalId,
					note: returnRequests.note,
					billedBy: returnRequests.billedBy,
					kind: returnRequests.kind,
					status: returnRequests.status,
					rawStatus: returnRequests.rawStatus,
					reason: returnRequests.reason,
					trackingNumber: returnRequests.trackingNumber,
					carrier: returnRequests.carrier,
					requestedAt: returnRequests.requestedAt,
					saved: {
						carrier: returnTracking.carrier,
						number: returnTracking.number,
						status: returnTracking.status,
						statusDetail: returnTracking.statusDetail,
						statusAt: returnTracking.statusAt,
						eta: returnTracking.eta,
						originalEta: returnTracking.originalEta,
						service: returnTracking.service,
						origin: returnTracking.origin,
						destination: returnTracking.destination,
						history: returnTracking.history,
						checkedAt: returnTracking.checkedAt,
					},
				})
				.from(returnRequests)
				.leftJoin(
					returnTracking,
					eq(returnTracking.returnRequestId, returnRequests.id),
				)
				.where(eq(returnRequests.orderId, data.id))
				.orderBy(desc(returnRequests.requestedAt)),
			db
				.select({
					requestId: returnRequestLines.requestId,
					orderLineId: returnRequestLines.orderLineId,
					sku: returnRequestLines.sku,
					quantity: returnRequestLines.quantity,
				})
				.from(returnRequestLines)
				.innerJoin(
					returnRequests,
					eq(returnRequests.id, returnRequestLines.requestId),
				)
				.where(eq(returnRequests.orderId, data.id))
				.orderBy(returnRequestLines.id),
			// Each return received, and where its units went.
			db
				.select({
					id: orderReturns.id,
					lineId: orderReturns.orderLineId,
					quantity: orderReturns.quantity,
					restocked: orderReturns.restocked,
					preCutover: orderReturns.preCutover,
					refurbId: refurbs.id,
					refurbSku: refurbs.sku,
					refurbCondition: refurbs.condition,
					createdAt: orderReturns.createdAt,
				})
				.from(orderReturns)
				.innerJoin(orderLines, eq(orderLines.id, orderReturns.orderLineId))
				.leftJoin(refurbs, eq(refurbs.id, orderReturns.refurbProductId))
				.where(eq(orderLines.orderId, data.id))
				.orderBy(desc(orderReturns.createdAt), orderReturns.id),
			returnStages(db, [data.id]),
			orderMail(db, order),
			// The same buyer by name and postal code. Masked names (TikTok's
			// "C****** D****") say nothing about who it is, so they're left out.
			order.customerName &&
			!order.customerName.includes("*") &&
			order.shipPostalCode
				? db
						.select({
							id: orders.id,
							name: orders.name,
							placedAt: orders.placedAt,
							total: orders.total,
							channel: stores.channel,
							salesChannel: orders.salesChannel,
							cancelledAt: orders.cancelledAt,
						})
						.from(orders)
						.innerJoin(stores, eq(stores.id, orders.storeId))
						.where(
							and(
								ne(orders.id, data.id),
								sql`lower(${orders.customerName}) = lower(${order.customerName})`,
								eq(orders.shipPostalCode, order.shipPostalCode),
							),
						)
						.orderBy(desc(orders.placedAt))
						.limit(10)
				: Promise.resolve([]),
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
			returnState: (due[0]?.state ?? null) as ReturnState | null,
			// Units expected back per line; for a maybe, the most that could come.
			expected: due.map(({ lineId, expected }) => ({ lineId, expected })),
			returnRequests: requests.map(({ saved, ...r }) => ({
				...r,
				// Where its package is, as Shippo last said; null until asked.
				tracking: trackingFor(r.trackingNumber, saved),
				lines: requestLines
					.filter((l) => l.requestId === r.id)
					.map(({ requestId: _, ...l }) => l),
				// Where it's handled, to confirm it arrived or refund it.
				page: returnPage(order, r.billedBy),
			})),
			returnsReceived: received.map(
				({ refurbId, refurbSku, refurbCondition, ...r }) => ({
					...r,
					refurb:
						refurbId && refurbSku && refurbCondition
							? { id: refurbId, sku: refurbSku, condition: refurbCondition }
							: null,
				}),
			),
			mail,
			buyerOrders,
			// How staff can write to the buyer from here.
			chat: chatWay(
				{
					...order,
					returnAsked: requests.length > 0,
					threads: mail.threads.map((t) => ({
						id: t.id,
						market: t.market,
						lastAt: t.messages.at(-1)?.at ?? null,
					})),
					amazonPage:
						adminUrls(order).find((p) => p.channel === "amazon")?.url ?? null,
				},
				new Date(),
			),
		};
	});

// Asks Shippo where a return request's package is and keeps the answer,
// for an order opened before the four-hourly sweep has asked. Null when
// its carrier isn't one Shippo follows.
export const followReturnNow = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [r] = await db
			.select({
				id: returnRequests.id,
				carrier: returnRequests.carrier,
				trackingNumber: returnRequests.trackingNumber,
			})
			.from(returnRequests)
			.where(eq(returnRequests.id, data.id));
		const saved = r ? await followReturn(db, r) : null;
		if (!saved) return null;
		const { returnRequestId: _, ...t } = saved;
		return t;
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

// Each package the order went out in, with every scan the carrier has
// given; asked of the channel and the carriers as the page opens.
export const getOrderPackages = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => (await orderSummary(getDb(), data.id)).packages);
