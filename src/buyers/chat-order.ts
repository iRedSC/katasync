import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders, stores } from "#/db/schema";

// The order a conversation with its buyer is opened from, as far as
// starting one needs it. Server only.

export async function chatOrder(db: Db, orderId: number) {
	const [o] = await db
		.select({
			id: orders.id,
			channel: stores.channel,
			externalId: orders.externalId,
			marketplaceOrderId: orders.marketplaceOrderId,
			buyerId: orders.buyerId,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(eq(orders.id, orderId));
	if (!o) throw new Error(`No order ${orderId}`);
	return o;
}

export type ChatOrderRow = Awaited<ReturnType<typeof chatOrder>>;

// An eBay order: the only kind eBay's calls are made for.
export type EbayOrder = ChatOrderRow & { channel: "ebay" };
export const isEbay = (o: ChatOrderRow): o is EbayOrder => o.channel === "ebay";
