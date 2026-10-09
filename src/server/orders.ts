import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import { getDb } from "#/db/client";
import { locations, orderLines, orders, products, stores } from "#/db/schema";
import { cityLine } from "#/lib/format";
import { needsShipping } from "#/orders/to-ship";

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
				pin: orders.pin,
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
				pin: orders.pin,
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

// Everything the invoices for orders still to ship print, in pin order so
// the stack matches what packers type.
export const listInvoices = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const locationId = await shippingLocation(db);
		const [from] = locationId
			? await db.select().from(locations).where(eq(locations.id, locationId))
			: [];
		const toShip = await db
			.select({
				id: orders.id,
				name: orders.name,
				pin: orders.pin,
				placedAt: orders.placedAt,
				salesChannel: orders.salesChannel,
				customerName: orders.customerName,
				shipAddress1: orders.shipAddress1,
				shipAddress2: orders.shipAddress2,
				shipCity: orders.shipCity,
				shipRegion: orders.shipRegion,
				shipPostalCode: orders.shipPostalCode,
				shipCountry: orders.shipCountry,
				total: orders.total,
				shippingCharged: orders.shippingCharged,
			})
			.from(orders)
			.where(needsShipping)
			.orderBy(asc(orders.pin), asc(orders.placedAt));
		const lines = toShip.length
			? await db
					.select({
						orderId: orderLines.orderId,
						sku: sql<
							string | null
						>`coalesce(${products.sku}, ${orderLines.sku})`,
						title: orderLines.title,
						quantity: orderLines.quantity,
						unitPrice: orderLines.unitPrice,
					})
					.from(orderLines)
					.leftJoin(products, eq(products.id, orderLines.productId))
					.where(
						inArray(
							orderLines.orderId,
							toShip.map((o) => o.id),
						),
					)
					.orderBy(orderLines.id)
			: [];
		return {
			from: from
				? {
						name: from.shipFromName ?? from.name,
						lines: [
							from.address1,
							from.address2,
							cityLine(from.city, from.region, from.postalCode),
						].filter((l): l is string => !!l),
						phone: from.phone,
						email: from.email,
					}
				: null,
			invoices: toShip.map((o) => ({
				...o,
				lines: lines.filter((l) => l.orderId === o.id),
			})),
		};
	},
);

export type OrderRow = Awaited<ReturnType<typeof listOrders>>[number];
export type OrderDetail = Awaited<ReturnType<typeof getOrder>>;
