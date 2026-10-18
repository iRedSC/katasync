import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, stockLevels } from "#/db/schema";

// Owned stock for each product, so a draft shows what's already on the shelf.
export async function onHandOf(db: Db, productIds: number[]) {
	if (productIds.length === 0) return new Map<number, number>();
	const rows = await db
		.select({
			productId: stockLevels.productId,
			onHand: sql<number>`sum(${stockLevels.onHand})::int`,
		})
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(
			and(
				eq(locations.kind, "owned"),
				inArray(stockLevels.productId, productIds),
			),
		)
		.groupBy(stockLevels.productId);
	return new Map(rows.map((r) => [r.productId, r.onHand]));
}
