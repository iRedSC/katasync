import { createSearchIndex, type SearchIndex, search } from "./search-ranking";

// Finding a product by what's typed: its SKU (or other codes) as typed or
// started, else its name, forgiving typos and word order
// (src/lib/search-ranking.ts). The index is built once per list.

export type Searchable = {
	sku: string;
	name: string;
	variantName: string | null;
	// Other codes it's typed as: a barcode, a supplier's part number.
	codes?: readonly (string | null)[];
};

type Entry = { title: string; skus: string[]; product: Searchable };
const built = new WeakMap<readonly Searchable[], SearchIndex<Entry>>();

export function productSearch<T extends Searchable>(
	products: readonly T[],
	query: string,
	{
		limit = 8,
		where,
		prefer,
	}: {
		limit?: number;
		// Only these are offered.
		where?: (product: T) => boolean;
		// Ranks these above the rest (see search's prefer).
		prefer?: (product: T) => boolean;
	} = {},
): T[] {
	if (query.trim() === "") return [];
	let index = built.get(products);
	if (!index) {
		index = createSearchIndex(
			products.map((p) => ({
				product: p,
				title: p.variantName ? `${p.name} ${p.variantName}` : p.name,
				// A part's own number leads its name: "[05-42S] Creaser Arm".
				skus: [
					p.sku,
					p.name.match(/^\[([^\]]+)\]/)?.[1] ?? null,
					...(p.codes ?? []),
				].filter((c): c is string => c !== null && c !== ""),
			})),
		);
		built.set(products, index);
	}
	const hits = search(index, query, {
		prefer: prefer && ((e) => prefer(e.product as T)),
	});
	const out: T[] = [];
	for (const hit of hits) {
		const p = hit.item.product as T;
		if (where && !where(p)) continue;
		out.push(p);
		if (out.length === limit) break;
	}
	return out;
}
