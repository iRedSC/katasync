import { and, eq } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import type { Db } from "#/db/client";
import { locations, productComponents, stockLevels } from "#/db/schema";
import { requestCounts } from "#/inventory/ledger";
import { isOurs } from "#/inventory/locations";

// Puts a product on the count list at every shelf of ours holding it, or the
// warehouse when none does yet. A tool set has no shelf of its own, so
// counting it means its parts. Returns the shelves this put on the list,
// leaving out any already waiting, so undo (cancelCountRequests) takes off
// only those.
export async function requestProductCount(db: Db, productId: number) {
	const parts = await db
		.select({ id: productComponents.componentProductId })
		.from(productComponents)
		.where(eq(productComponents.parentProductId, productId));
	const added = [];
	for (const id of parts.length > 0 ? parts.map((p) => p.id) : [productId])
		added.push(...(await requestShelfCounts(db, id)));
	return added;
}

// Puts each of our shelves holding the product on the count list, or the
// warehouse when none holds it yet.
async function requestShelfCounts(db: Db, productId: number) {
	const [held, warehouse] = await Promise.all([
		db
			.select({ locationId: stockLevels.locationId })
			.from(stockLevels)
			.innerJoin(locations, eq(locations.id, stockLevels.locationId))
			.where(and(eq(stockLevels.productId, productId), isOurs)),
		shippingLocation(db),
	]);
	if (held.length === 0 && warehouse === null)
		throw new Error("Add a location first");
	const at =
		held.length > 0 || warehouse === null
			? held.map((h) => h.locationId)
			: [warehouse];
	const added = [];
	for (const locationId of at)
		added.push(
			...(await requestCounts(db, {
				productIds: [productId],
				locationId,
			})),
		);
	return added;
}
