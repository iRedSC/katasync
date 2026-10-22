import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "#/db/client";
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

	const requested = await db
		.select()
		.from(products)
		.where(inArray(products.id, productIds));
	const bundleIds = requested
		.filter((s) => s.kind === "bundle")
		.map((s) => s.id);
	const recipes =
		bundleIds.length === 0
			? []
			: await db
					.select()
					.from(productComponents)
					.where(inArray(productComponents.parentProductId, bundleIds));

	const stockedIds = [
		...new Set([
			...requested.filter((s) => s.kind !== "bundle").map((s) => s.id),
			...recipes.map((r) => r.componentProductId),
		]),
	];
	const onHand = new Map<number, number>();
	if (stockedIds.length > 0 && locationIds.length > 0) {
		const rows = await db
			.select({
				productId: stockLevels.productId,
				locationId: stockLevels.locationId,
				onHand: stockLevels.onHand,
			})
			.from(stockLevels)
			.where(
				and(
					inArray(stockLevels.productId, stockedIds),
					inArray(stockLevels.locationId, locationIds),
				),
			);
		// The other shelves together, then what the kept one can spare.
		const main = new Map<number, number>();
		const spare = new Map<number, number>();
		for (const row of rows) {
			if (keep && row.locationId === keep.locationId)
				spare.set(row.productId, Math.max(0, row.onHand - keep.units));
			else main.set(row.productId, (main.get(row.productId) ?? 0) + row.onHand);
		}
		for (const id of new Set([...main.keys(), ...spare.keys()]))
			onHand.set(id, Math.max(0, main.get(id) ?? 0) + (spare.get(id) ?? 0));
	}
	const { uncounted } = options;
	const unlimited = new Set<number>();
	if (uncounted !== undefined && stockedIds.length > 0) {
		const rows = await db
			.select({ id: products.id })
			.from(products)
			.where(
				and(
					inArray(products.id, stockedIds),
					isNotNull(products.notCountedSince),
				),
			);
		for (const row of rows) {
			unlimited.add(row.id);
			onHand.set(row.id, uncounted);
		}
	}

	// Each bundle's parts, found once rather than scanned for every bundle.
	const partsOf = new Map<number, (typeof productComponents.$inferSelect)[]>();
	for (const r of recipes) {
		const parts = partsOf.get(r.parentProductId) ?? [];
		parts.push(r);
		partsOf.set(r.parentProductId, parts);
	}
	for (const sku of requested) {
		if (sku.kind !== "bundle") {
			result.set(sku.id, onHand.get(sku.id) ?? 0);
			continue;
		}
		const parts = partsOf.get(sku.id) ?? [];
		result.set(
			sku.id,
			parts.length === 0
				? 0
				: Math.min(
						...parts.map((p) => {
							const has = onHand.get(p.componentProductId) ?? 0;
							// However many it takes, a part without limit doesn't limit.
							return unlimited.has(p.componentProductId)
								? has
								: Math.floor(has / p.quantity);
						}),
					),
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
