import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	buyerThreads,
	dispatchOrders,
	orderLines,
	orders,
	products,
	shipments,
	stores,
} from "#/db/schema";
import { returnStages } from "#/orders/return-stage";
import { orderStatus } from "#/orders/status";
import { labelToVoid } from "#/orders/to-ship";
import type { Carrier } from "#/purchasing/inbox/tracking-numbers";
import { askShippo } from "#/purchasing/tracking";

// What a buyer's order is and where its packages are, for the top of their
// conversation: the products, and each package's tracking as the carrier
// tells it now (through Shippo). A carrier that can't be asked leaves what
// katasync knows. Server only.

const CARRIERS: Record<string, Carrier> = {
	usps: "usps",
	ups: "ups",
	fedex: "fedex",
};

// The carrier's own tracking page, for labels without one (TikTok's).
const pageOf = (carrier: Carrier, number: string) =>
	carrier === "ups"
		? `https://www.ups.com/track?tracknum=${number}`
		: carrier === "usps"
			? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`
			: `https://www.fedex.com/fedextrack/?trknbr=${number}`;

export async function buyerOrder(db: Db, threadId: number) {
	const [found] = await db
		.select({ id: orders.id })
		.from(buyerThreads)
		.innerJoin(stores, eq(stores.channel, buyerThreads.market))
		.innerJoin(
			orders,
			and(
				eq(orders.storeId, stores.id),
				eq(orders.externalId, buyerThreads.orderRef),
			),
		)
		.where(eq(buyerThreads.id, threadId))
		.limit(1);
	return found ? orderSummary(db, found.id) : null;
}

// An order's status, products, and packages, wherever it's shown beside
// mail.
export async function orderSummary(db: Db, orderId: number) {
	const [[order], stages, lines, sent] = await Promise.all([
		db
			.select({
				id: orders.id,
				name: orders.name,
				cancelledAt: orders.cancelledAt,
				fulfillmentStatus: orders.fulfillmentStatus,
				financialStatus: orders.financialStatus,
				channel: stores.channel,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				externalId: orders.externalId,
				shipCountry: orders.shipCountry,
				fulfilledByChannel: orders.fulfilledByChannel,
				labelToVoid,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(eq(orders.id, orderId)),
		returnStages(db, [orderId]),
		db
			.select({
				id: orderLines.id,
				title: orderLines.title,
				quantity: orderLines.quantity,
				imageUrl: products.imageUrl,
				productSku: products.sku,
			})
			.from(orderLines)
			.leftJoin(products, eq(products.id, orderLines.productId))
			.where(eq(orderLines.orderId, orderId))
			.orderBy(orderLines.id),
		db
			.select({
				id: shipments.id,
				carrier: shipments.carrier,
				service: shipments.serviceName,
				number: shipments.trackingNumber,
				url: shipments.trackingUrl,
				shippedAt: shipments.createdAt,
			})
			.from(shipments)
			.innerJoin(
				dispatchOrders,
				eq(dispatchOrders.dispatchId, shipments.dispatchId),
			)
			.where(
				and(eq(dispatchOrders.orderId, orderId), isNull(shipments.voidedAt)),
			)
			.orderBy(shipments.createdAt),
	]);
	const packages = await Promise.all(
		sent.map(async (p) => {
			const carrier = CARRIERS[p.carrier.toLowerCase()];
			const known = {
				...p,
				url: p.url ?? (carrier && p.number ? pageOf(carrier, p.number) : null),
				status: null,
				statusDetail: null,
				eta: null,
				deliveredAt: null,
			};
			if (!carrier || !p.number || !process.env.SHIPPO_API_KEY) return known;
			try {
				const t = await askShippo(carrier, p.number);
				return {
					...known,
					status: t.status,
					statusDetail: t.statusDetail,
					eta: t.eta,
					deliveredAt: t.status === "DELIVERED" ? t.statusAt : null,
				};
			} catch {
				return known;
			}
		}),
	);
	if (!order) throw new Error(`No order ${orderId}`);
	return {
		id: order.id,
		name: order.name,
		status: orderStatus({
			...order,
			returnStage: stages.get(orderId) ?? null,
		}),
		lines,
		packages,
	};
}

export type BuyerOrder = Awaited<ReturnType<typeof orderSummary>>;
