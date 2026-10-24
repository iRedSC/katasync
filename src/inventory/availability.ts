import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import { committedStock } from "#/db/quantity-schema";
import { productComponents, products, stockLevels } from "#/db/schema";
import type { OnlineStock } from "./online-stock";

// Sellable units per SKU across the given locations. Simple SKUs and kits use
// their own stock. A bundle is limited by its scarcest component. Negative
// stock counts as zero, and the `keep` shelf (the retail store) gives only
// what it holds above what it keeps, as a shipped order takes it. Pass `uncounted` to have a product that isn't counted
// yet (src/inventory/not-counted.ts) sell that many whatever its number, and
// stop limiting the tool sets it's in.
export async function getAvailability(
	db: Db,
	productIds: number[],
	from: OnlineStock,
	options: { uncounted?: number } = {},
): Promise<Map<number, number>> {
	const { locationIds, keep } = from;
	const result = new Map<number, number>();
	if (productIds.length === 0) return result;
	const stocked = alias(products, "availability_stocked");
	const stockedId = sql<
		number | null
	>`case when ${products.kind} = 'bundle' then ${productComponents.componentProductId} else ${products.id} end`;
	const keptId = keep?.locationId ?? -1;
	const rows = await db
		.select({
			id: products.id,
			kind: products.kind,
			stockedId,
			quantity: sql<number>`coalesce(${productComponents.quantity}, 1)`,
			notCountedSince: stocked.notCountedSince,
			main: sql<number>`coalesce(sum(case when ${stockLevels.locationId} <> ${keptId} then ${stockLevels.onHand} else 0 end), 0)::int`,
			kept: sql<number>`coalesce(max(case when ${stockLevels.locationId} = ${keptId} then ${stockLevels.onHand} end), 0)::int`,
			committed: sql<number>`case when (select mode from quantity_mode where id = 1) = 'committed' then coalesce(${committedStock.units}, 0) else 0 end`,
		})
		.from(products)
		.leftJoin(
			productComponents,
			and(
				eq(productComponents.parentProductId, products.id),
				eq(products.kind, "bundle"),
			),
		)
		.leftJoin(stocked, eq(stocked.id, stockedId))
		.leftJoin(committedStock, eq(committedStock.productId, stocked.id))
		.leftJoin(
			stockLevels,
			and(
				eq(stockLevels.productId, stocked.id),
				locationIds.length > 0
					? inArray(stockLevels.locationId, locationIds)
					: sql`false`,
			),
		)
		.where(inArray(products.id, productIds))
		.groupBy(
			products.id,
			products.kind,
			productComponents.componentProductId,
			productComponents.quantity,
			stocked.id,
			stocked.notCountedSince,
			committedStock.units,
		);
	for (const row of rows) {
		const override =
			row.notCountedSince !== null ? options.uncounted : undefined;
		const physical =
			Math.max(0, row.main) + (keep ? Math.max(0, row.kept - keep.units) : 0);
		const units = override ?? Math.max(0, physical - row.committed);
		const available =
			row.kind === "bundle"
				? row.stockedId === null
					? 0
					: override !== undefined
						? units
						: Math.floor(units / row.quantity)
				: units;
		const previous = result.get(row.id);
		result.set(
			row.id,
			previous === undefined ? available : Math.min(previous, available),
		);
	}
	return result;
}

// Every bundle that contains this SKU. When a component's stock changes, these
// listings need a fresh quantity pushed too.
export async function getBundlesContaining(
	db: Db,
	productId: number,
): Promise<number[]> {
	const rows = await db
		.select({ id: productComponents.parentProductId })
		.from(productComponents)
		.innerJoin(products, eq(products.id, productComponents.parentProductId))
		.where(
			and(
				eq(productComponents.componentProductId, productId),
				eq(products.kind, "bundle"),
			),
		);
	return rows.map((r) => r.id);
}

// Components that leave a bundle with nothing to sell, and which bundles each
// one blocks. A component blocks a bundle when there isn't enough of it for
// even one unit. Sorted so the part blocking the most bundles comes first.
export async function getBundleBlockers(
	db: Db,
	from: OnlineStock,
): Promise<{ productId: number; blocks: number[] }[]> {
	const recipes = await db
		.select({
			bundleId: productComponents.parentProductId,
			componentId: productComponents.componentProductId,
			quantity: productComponents.quantity,
		})
		.from(productComponents)
		.innerJoin(products, eq(products.id, productComponents.parentProductId))
		.where(eq(products.kind, "bundle"));
	// A part that sells without limit never blocks a set.
	const available = await getAvailability(
		db,
		[...new Set(recipes.map((r) => r.componentId))],
		from,
		{ uncounted: Number.POSITIVE_INFINITY },
	);

	const blocks = new Map<number, number[]>();
	for (const r of recipes) {
		if ((available.get(r.componentId) ?? 0) < r.quantity) {
			blocks.set(r.componentId, [
				...(blocks.get(r.componentId) ?? []),
				r.bundleId,
			]);
		}
	}
	return [...blocks]
		.map(([productId, bundles]) => ({ productId, blocks: bundles }))
		.sort((a, b) => b.blocks.length - a.blocks.length);
}
