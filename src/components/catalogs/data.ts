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

export type OfferTerms =
	| { cost: number | null }
	| { supplierSku: string | null };

// The catalog with one supplier's terms for a product changed. Every other
// product, and every other offer, is the same object as before, so rows that
// didn't change don't render again.
export function withTerms(
	d: CatalogDetail,
	productId: number,
	supplierId: number,
	terms: OfferTerms,
): CatalogDetail {
	return {
		...d,
		products: d.products.map((x) =>
			x.id !== productId
				? x
				: {
						...x,
						offers: x.offers.map((y) =>
							y.supplierId !== supplierId
								? y
								: "cost" in terms
									? {
											...y,
											cost: terms.cost,
											itemCost:
												terms.cost === null ? null : terms.cost / y.packSize,
										}
									: { ...y, supplierSku: terms.supplierSku },
						),
					},
		),
	};
}
