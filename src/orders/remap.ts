import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { listings, orderLines, orders, stores } from "#/db/schema";
import { costOf, orderTakesStock, takeStock } from "./ingest";

// After listings get a product, catch up the orders that already sold them:
// each line picks up the product and its cost, and lines on orders that take
// stock take it now. Safe to repeat; a line never takes stock twice.
export async function applyListingsToOrders(
	db: Db,
	listingIds: number[],
	locationId: number | null,
): Promise<{ lines: number; problems: string[] }> {
	if (listingIds.length === 0) return { lines: 0, problems: [] };
	return db.transaction(async (tx) => {
		const pending = await tx
			.select({
				line: orderLines,
				productId: listings.productId,
				order: {
					name: orders.name,
					placedAt: orders.placedAt,
					cancelledAt: orders.cancelledAt,
					fulfilledByChannel: orders.fulfilledByChannel,
				},
				store: { id: stores.id, stockFrom: stores.stockFrom },
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.innerJoin(
				listings,
				and(
					eq(listings.storeId, orders.storeId),
					eq(listings.externalId, orderLines.listingExternalId),
				),
			)
			.where(
				and(inArray(listings.id, listingIds), isNull(orderLines.productId)),
			);

		const problems: string[] = [];
		for (const { line, productId, order, store } of pending) {
			if (productId === null) continue;
			await tx
				.update(orderLines)
				.set({ productId, unitCost: await costOf(tx, productId) })
				.where(eq(orderLines.id, line.id));
			if (line.saleBatchId || !orderTakesStock(store, order)) continue;
			const problem = await takeStock(
				tx,
				{ ...line, productId },
				order.name,
				locationId,
			);
			if (problem) problems.push(problem);
		}
		return { lines: pending.length, problems };
	});
}
