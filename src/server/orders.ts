import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import { orderLines, orders, products, stores } from "#/db/schema";

// The one definition of "someone still has to ship this": not cancelled, not
// refunded or voided, and not fully fulfilled. Shopify's own "unfulfilled"
// filter also counts cancelled and refunded orders, so it can't be used as-is.
export const needsShipping = and(
	isNull(orders.cancelledAt),
	notInArray(orders.fulfillmentStatus, [
		"FULFILLED",
		"FULFILLMENT_NOT_REQUIRED",
		"RESTOCKED",
	]),
	sql`coalesce(${orders.financialStatus}, '') not in ('REFUNDED', 'VOIDED')`,
);

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
		const lineStats = getDb()
			.select({
				orderId: orderLines.orderId,
				items: sql<number>`sum(${orderLines.quantity})::int`.as("items"),
				unmatched:
					sql<number>`count(*) filter (where ${orderLines.productId} is null and ${orderLines.sku} is not null)::int`.as(
						"unmatched",
					),
			})
			.from(orderLines)
			.groupBy(orderLines.orderId)
			.as("line_stats");
		return getDb()
			.select({
				id: orders.id,
				name: orders.name,
				salesChannel: orders.salesChannel,
				placedAt: orders.placedAt,
				cancelledAt: orders.cancelledAt,
				fulfillmentStatus: orders.fulfillmentStatus,
				financialStatus: orders.financialStatus,
				customerName: orders.customerName,
				shipCity: orders.shipCity,
				shipRegion: orders.shipRegion,
				total: orders.total,
				store: stores.name,
				channel: stores.channel,
				items: sql<number>`coalesce(${lineStats.items}, 0)`,
				unmatched: sql<number>`coalesce(${lineStats.unmatched}, 0)`,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.leftJoin(lineStats, eq(lineStats.orderId, orders.id))
			.where(data.view === "ship" ? needsShipping : undefined)
			.orderBy(desc(orders.placedAt))
			.limit(data.view === "ship" ? 500 : 200);
	});

export const getOrder = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [order] = await db
			.select({
				id: orders.id,
				name: orders.name,
				salesChannel: orders.salesChannel,
				placedAt: orders.placedAt,
				cancelledAt: orders.cancelledAt,
				fulfillmentStatus: orders.fulfillmentStatus,
				financialStatus: orders.financialStatus,
				customerName: orders.customerName,
				shipCity: orders.shipCity,
				shipRegion: orders.shipRegion,
				shipCountry: orders.shipCountry,
				total: orders.total,
				shippingCharged: orders.shippingCharged,
				store: stores.name,
				channel: stores.channel,
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
				productSku: products.sku,
				productName: products.name,
				imageUrl: products.imageUrl,
			})
			.from(orderLines)
			.leftJoin(products, eq(products.id, orderLines.productId))
			.where(eq(orderLines.orderId, data.id))
			.orderBy(orderLines.id);
		return { order, lines };
	});

export type OrderRow = Awaited<ReturnType<typeof listOrders>>[number];
export type OrderDetail = Awaited<ReturnType<typeof getOrder>>;
