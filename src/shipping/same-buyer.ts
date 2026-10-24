import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders } from "#/db/schema";
import { groupBy } from "#/lib/group-by";
import { needsShipping } from "#/orders/to-ship";
import { liveDispatches } from "./dispatch";

export type SameBuyer = {
	id: number;
	name: string;
	pin: number | null;
	marketplaceOrderId: string | null;
};

type Open = SameBuyer & { storeId: number; buyerId: string | null };

// TikTok sells one label per order, and its combine endpoints refuse a US
// shop, so one buyer's orders only share a box if someone combines them in
// Seller Center before a label is bought. For each order, the same buyer's
// other orders on the same store; orders with a label are left out, since
// it's too late for them.
export function sameBuyerGroups(
	open: readonly Open[],
	live: readonly { orderId: number }[],
): Map<number, SameBuyer[]> {
	const labelled = new Set(live.map((l) => l.orderId));
	const groups = groupBy(
		open.filter((o) => o.buyerId !== null && !labelled.has(o.id)),
		(o) => `${o.storeId}:${o.buyerId}`,
	);
	const others = new Map<number, SameBuyer[]>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		for (const o of group) {
			others.set(
				o.id,
				group
					.filter((c) => c.id !== o.id)
					.map(({ id, name, pin, marketplaceOrderId }) => ({
						id,
						name,
						pin,
						marketplaceOrderId,
					})),
			);
		}
	}
	return others;
}

// sameBuyerGroups over the orders still to ship, or just one buyer's.
export async function sameBuyerOrders(
	db: Db,
	buyer?: { storeId: number; buyerId: string },
) {
	const open = await db
		.select({
			id: orders.id,
			name: orders.name,
			pin: orders.pin,
			marketplaceOrderId: orders.marketplaceOrderId,
			storeId: orders.storeId,
			buyerId: orders.buyerId,
		})
		.from(orders)
		.where(
			and(
				needsShipping,
				buyer
					? and(
							eq(orders.storeId, buyer.storeId),
							eq(orders.buyerId, buyer.buyerId),
						)
					: isNotNull(orders.buyerId),
			),
		);
	return sameBuyerGroups(
		open,
		await liveDispatches(
			db,
			open.map((o) => o.id),
		),
	);
}
