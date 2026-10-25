import { and, eq } from "drizzle-orm";
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
import { carrierOf, channelPackages } from "#/orders/channel-tracking";
import { returnStages } from "#/orders/return-stage";
import { orderStatus } from "#/orders/status";
import { financialStatus, labelToVoid } from "#/orders/to-ship";
import {
	type Carrier,
	normalTracking,
} from "#/purchasing/inbox/tracking-numbers";
import { askShippo } from "#/purchasing/tracking";

// What a buyer's order is and where its packages are, for the top of their
// conversation and the order page: the products, and each package (ours,
// and those the channel says it shipped on labels bought there) with every
// scan the carrier has given (through Shippo). A carrier that can't be asked leaves what
// katasync knows. Server only.

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
				financialStatus,
				channel: stores.channel,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				externalId: orders.externalId,
				sourceUpdatedAt: orders.sourceUpdatedAt,
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
				voidedAt: shipments.voidedAt,
			})
			.from(shipments)
			.innerJoin(
				dispatchOrders,
				eq(dispatchOrders.dispatchId, shipments.dispatchId),
			)
			.where(eq(dispatchOrders.orderId, orderId))
			.orderBy(shipments.createdAt),
	]);
	if (!order) throw new Error(`No order ${orderId}`);
	// The channel's too, bought on its site; a number of a label of ours,
	// voided ones included, is ours and not shown twice.
	const ours = new Set(
		sent.flatMap((p) => (p.number ? [normalTracking(p.number)] : [])),
	);
	const theirs = (await channelPackages(db, order)).filter(
		(p) => !ours.has(normalTracking(p.number)),
	);
	const known = [
		...sent
			.filter((p) => p.voidedAt === null)
			.map((p) => ({
				key: `s${p.id}`,
				carrier: p.carrier,
				service: p.service,
				number: p.number,
				url: p.url,
				shippedAt: p.shippedAt as Date | null,
			})),
		...theirs.map((p) => ({
			key: `c${normalTracking(p.number)}`,
			carrier: p.carrier,
			service: null,
			number: p.number as string | null,
			url: null,
			shippedAt: null,
		})),
	];
	const packages = await Promise.all(
		known.map(async (p) => {
			const carrier = p.number ? carrierOf(p.carrier, p.number) : null;
			const base = {
				...p,
				url: p.url ?? (carrier && p.number ? pageOf(carrier, p.number) : null),
				status: null,
				statusDetail: null,
				eta: null,
				deliveredAt: null,
				// Every scan, for the timeline; null when Shippo wasn't asked.
				tracking: null,
			};
			if (!carrier || !p.number || !process.env.SHIPPO_API_KEY) return base;
			try {
				const t = await askShippo(carrier, p.number);
				return {
					...base,
					status: t.status,
					statusDetail: t.statusDetail,
					eta: t.eta,
					deliveredAt: t.status === "DELIVERED" ? t.statusAt : null,
					tracking: {
						...t,
						carrier,
						number: p.number,
						checkedAt: new Date(),
					},
				};
			} catch {
				return base;
			}
		}),
	);
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
