import { optimistic, type Patch } from "#/lib/optimism";
import type { View } from "#/products/views";
import { listProducts, type ProductRow } from "#/server/catalog";
import { listViews } from "#/server/views";

// What the page loads. The optimistic patches below lay changes over it until
// the reload shows them.
export const loadPage = async () => {
	const [products, views] = await Promise.all([listProducts(), listViews()]);
	return { ...products, views };
};
type ProductsPage = Awaited<ReturnType<typeof loadPage>>;
export const productsData = optimistic<ProductsPage>("products");

// A change to one product's row on the list.
export function patchProduct(
	productId: number,
	change: (p: ProductRow) => ProductRow,
): Patch {
	return productsData.patch("all", (d) => ({
		...d,
		products: d.products.map((p) => (p.id === productId ? change(p) : p)),
	}));
}

// A change to the saved views, which the tabs and the Save buttons show.
export function patchViews(change: (views: View[]) => View[]): Patch {
	return productsData.patch("all", (d) => ({ ...d, views: change(d.views) }));
}
