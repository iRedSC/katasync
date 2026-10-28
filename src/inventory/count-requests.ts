import { and, eq, inArray } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import type { Db } from "#/db/client";
import { locations, productComponents, stockLevels } from "#/db/schema";
import { requestCounts } from "#/inventory/ledger";
import { lockStockProducts } from "#/inventory/ledger/post";
import { isOurs } from "#/inventory/locations";

// Puts each product on the count list at every shelf of ours holding it, or
// the warehouse when none does yet. A tool set has no shelf of its own, so
// counting it means its parts. All or nothing: one product that can't be
// counted puts none on the list, so undo always has every request made.
// Returns the shelves this put on the list, leaving out any already waiting,
// so undo (cancelCountRequests) takes off only those.
export async function requestProductCounts(db: Db, productIds: number[]) {
	if (productIds.length === 0) return [];
	return db.transaction(async (tx) => {
		const parts = await tx
			.select({
				parentId: productComponents.parentProductId,
				id: productComponents.componentProductId,
			})
			.from(productComponents)
			.where(inArray(productComponents.parentProductId, productIds));
		const shelfProducts = [
			...new Set(
				productIds.flatMap((productId) => {
					const own = parts.filter((p) => p.parentId === productId);
					return own.length > 0 ? own.map((p) => p.id) : [productId];
				}),
			),
		];
		// Every product locked up front in one order, so two batches sharing
		// products can't each hold one the other waits on.
		await lockStockProducts(tx, shelfProducts);
		const held = await tx
			.select({
				productId: stockLevels.productId,
				locationId: stockLevels.locationId,
			})
			.from(stockLevels)
			.innerJoin(locations, eq(locations.id, stockLevels.locationId))
			.where(and(inArray(stockLevels.productId, shelfProducts), isOurs));
		const warehouse = await shippingLocation(tx);
		const byLocation = new Map<number, number[]>();
		for (const productId of shelfProducts) {
			const shelves = held.filter((h) => h.productId === productId);
			if (shelves.length === 0 && warehouse === null)
				throw new Error("Add a location first");
			const at =
				shelves.length > 0 || warehouse === null
					? shelves.map((h) => h.locationId)
					: [warehouse];
			for (const locationId of at)
				byLocation.set(locationId, [
					...(byLocation.get(locationId) ?? []),
					productId,
				]);
		}
		const added = [];
		for (const [locationId, ids] of byLocation)
			added.push(...(await requestCounts(tx, { productIds: ids, locationId })));
		return added;
	});
}
