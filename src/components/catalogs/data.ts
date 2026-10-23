import { optimistic } from "#/lib/optimism";
import type { CatalogDetail } from "#/server/purchasing";

// A catalog's page, with changes not yet confirmed laid over it.
export const catalogData = optimistic<CatalogDetail>("catalog");

export type CatalogProduct = CatalogDetail["products"][number];
export type CatalogOffer = CatalogProduct["offers"][number];

// The page's catalog once `change` is made to it.
export const patchCatalog = (
	id: number,
	change: (d: CatalogDetail) => CatalogDetail,
) => catalogData.patch(String(id), change);

// What one of a product costs at its cheapest, which values its stock.
export function cheapestItemCost(p: CatalogProduct) {
	return p.offers.find((o) => o.cheapest)?.itemCost ?? null;
}
