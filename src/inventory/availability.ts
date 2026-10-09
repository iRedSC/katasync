import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { skuComponents, skus, stockLevels } from "#/db/schema";

// Sellable units per SKU across the given locations. Simple SKUs and kits use
// their own stock. A bundle is limited by its scarcest component. Negative
// stock counts as zero.
export async function getAvailability(
	db: Db,
	skuIds: number[],
	locationIds: number[],
): Promise<Map<number, number>> {
	const result = new Map<number, number>();
	if (skuIds.length === 0) return result;

	const requested = await db
		.select()
		.from(skus)
		.where(inArray(skus.id, skuIds));
	const bundleIds = requested
		.filter((s) => s.kind === "bundle")
		.map((s) => s.id);
	const recipes =
		bundleIds.length === 0
			? []
			: await db
					.select()
					.from(skuComponents)
					.where(inArray(skuComponents.parentSkuId, bundleIds));

	const stockedIds = [
		...new Set([
			...requested.filter((s) => s.kind !== "bundle").map((s) => s.id),
			...recipes.map((r) => r.componentSkuId),
		]),
	];
	const onHand = new Map<number, number>();
	if (stockedIds.length > 0 && locationIds.length > 0) {
		const rows = await db
			.select({
				skuId: stockLevels.skuId,
				onHand: sql<number>`sum(${stockLevels.onHand})::int`,
			})
			.from(stockLevels)
			.where(
				and(
					inArray(stockLevels.skuId, stockedIds),
					inArray(stockLevels.locationId, locationIds),
				),
			)
			.groupBy(stockLevels.skuId);
		for (const row of rows) onHand.set(row.skuId, Math.max(0, row.onHand));
	}

	for (const sku of requested) {
		if (sku.kind !== "bundle") {
			result.set(sku.id, onHand.get(sku.id) ?? 0);
			continue;
		}
		const parts = recipes.filter((r) => r.parentSkuId === sku.id);
		result.set(
			sku.id,
			parts.length === 0
				? 0
				: Math.min(
						...parts.map((p) =>
							Math.floor((onHand.get(p.componentSkuId) ?? 0) / p.quantity),
						),
					),
		);
	}
	return result;
}

// Every bundle that contains this SKU. When a component's stock changes, these
// listings need a fresh quantity pushed too.
export async function getBundlesContaining(
	db: Db,
	skuId: number,
): Promise<number[]> {
	const rows = await db
		.select({ id: skuComponents.parentSkuId })
		.from(skuComponents)
		.innerJoin(skus, eq(skus.id, skuComponents.parentSkuId))
		.where(
			and(eq(skuComponents.componentSkuId, skuId), eq(skus.kind, "bundle")),
		);
	return rows.map((r) => r.id);
}
