import { and, eq, getTableColumns } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	orders,
	shipments,
	stores,
} from "#/db/schema";

// The channels katasync sends tracking to, by the name people use.
export const trackingChannels: Record<string, string> = {
	shopify: "Shopify",
	ebay: "eBay",
	tiktok: "TikTok",
};

// A box's columns but its label PDF: nothing here needs the PDF, and reading
// it for every box of a dispatch was the slow part.
export const { labelPdf: _labelPdf, ...boxColumns } =
	getTableColumns(shipments);
export type Box = Omit<typeof shipments.$inferSelect, "labelPdf">;

export async function load(db: Db, dispatchId: number) {
	const [dispatch] = await db
		.select()
		.from(dispatches)
		.where(eq(dispatches.id, dispatchId));
	const boxes = await db
		.select(boxColumns)
		.from(shipments)
		.where(eq(shipments.dispatchId, dispatchId))
		.orderBy(shipments.id);
	const members = await db
		.select({
			handoff: dispatchOrders,
			order: {
				id: orders.id,
				name: orders.name,
				externalId: orders.externalId,
				fulfillmentStatus: orders.fulfillmentStatus,
				cancelledAt: orders.cancelledAt,
				financialStatus: orders.financialStatus,
				salesChannel: orders.salesChannel,
				marketplaceOrderId: orders.marketplaceOrderId,
				shipCountry: orders.shipCountry,
			},
			channel: stores.channel,
		})
		.from(dispatchOrders)
		.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(eq(dispatchOrders.dispatchId, dispatchId))
		.orderBy(orders.id);
	if (!dispatch || boxes.length === 0 || members.length === 0) {
		throw new Error(`No dispatch ${dispatchId}`);
	}
	return { dispatch, boxes, members };
}

export type Member = Awaited<ReturnType<typeof load>>["members"][number];

export const sameMember = (member: Member) =>
	and(
		eq(dispatchOrders.dispatchId, member.handoff.dispatchId),
		eq(dispatchOrders.orderId, member.handoff.orderId),
	);
