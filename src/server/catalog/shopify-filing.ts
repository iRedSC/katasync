// How Shopify files each product: its status, and the tags, type and vendor
// its listings carry. A product can sell through several Shopify listings
// (variants, or a second store). Tags, type and vendor are pooled from every
// listing, since a listing that ended keeps its filing as history. The status
// is only what the product is filed as now, so it comes from listings still
// on the channel: an ended one doesn't make a product active.

// The most visible status wins, so a product that's live anywhere reads as
// active.
const STATUS_RANK = ["ACTIVE", "DRAFT", "ARCHIVED"];

export type FilingRow = {
	productId: number | null;
	tags: string[];
	productType: string | null;
	vendor: string | null;
	status: string | null;
	// Set once the channel stopped reporting the listing.
	goneAt: Date | null;
};

export type Filing = {
	tags: Set<string>;
	productType: string | null;
	vendor: string | null;
	// Null when no listing still on the channel says what it's filed as.
	status: string | null;
};

export function shopifyFiling(rows: FilingRow[]) {
	const byProduct = new Map<number, Filing>();
	// Unknown statuses (Shopify adds them now and then) rank after the known ones.
	const rank = (s: string | null) => {
		if (s === null) return Infinity;
		const i = STATUS_RANK.indexOf(s);
		return i === -1 ? STATUS_RANK.length : i;
	};
	for (const row of rows) {
		if (row.productId === null) continue;
		const f = byProduct.get(row.productId) ?? {
			tags: new Set<string>(),
			productType: null,
			vendor: null,
			status: null,
		};
		for (const tag of row.tags) f.tags.add(tag);
		f.productType ??= row.productType;
		f.vendor ??= row.vendor;
		if (row.goneAt === null && rank(row.status) < rank(f.status))
			f.status = row.status;
		byProduct.set(row.productId, f);
	}
	return byProduct;
}
