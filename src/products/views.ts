import { type } from "arktype";
import { FIELDS, type Filter } from "#/products/search";
import {
	DATE,
	NUMBER,
	parseSort,
	type Sort,
	type SortColumns,
	spellSort,
	TEXT,
} from "#/products/sort";

// Every column the product list can sort on, typed as ^key in the search box.
// Keys are one lowercase word so they're quick to type.
export const PRODUCT_SORTS = {
	name: { label: "Name", ...TEXT },
	sku: { label: "SKU", ...TEXT },
	class: { label: "Class", asc: "A first", desc: "C first" },
	inventory: { label: "Inventory", ...NUMBER },
	onhand: { label: "On hand", ...NUMBER },
	available: { label: "Available", ...NUMBER },
	onorder: { label: "On order", ...NUMBER },
	velocity: { label: "Sold a month", ...NUMBER },
	reorder: { label: "To reorder", ...NUMBER },
	runout: { label: "Runs out", asc: "soonest first", desc: "latest first" },
	min: { label: "Min stock", ...NUMBER },
	max: { label: "Max stock", ...NUMBER },
	cost: { label: "Cost", ...NUMBER },
	worth: { label: "Stock worth", ...NUMBER },
	counted: { label: "Last counted", ...DATE },
	type: { label: "Type", ...TEXT },
	vendor: { label: "Vendor", ...TEXT },
	supplier: { label: "Supplier", ...TEXT },
	catalog: { label: "Catalog", ...TEXT },
	level: { label: "Stock level", asc: "worst first", desc: "fullest first" },
	step: { label: "Next step", asc: "most to do first", desc: "least first" },
	trust: { label: "Trust", asc: "least trusted first", desc: "counted first" },
	ordercost: { label: "Order cost", ...NUMBER },
	tags: { label: "Tags", ...TEXT },
	listing: { label: "Shopify status", ...TEXT },
} as const satisfies SortColumns<string>;
export type ProductSortKey = keyof typeof PRODUCT_SORTS;
export type ProductSort = Sort<ProductSortKey>;

// A product sort as it travels through the URL and the database, e.g.
// "class,-velocity". Only spellProductSort makes one, so an unchecked string
// can't pass for it. Empty is name order, which is how the server sends them.
export type SortText = string & { readonly __spelled: unique symbol };

export function spellProductSort(sort: ProductSort): SortText {
	const text = spellSort(sort);
	return (text === "name" ? "" : text) as SortText;
}

// Before every column could sort, "value" meant most valuable first: class.
export function parseProductSort(text: string): ProductSort {
	return parseSort(text === "value" ? "class" : text, PRODUCT_SORTS);
}

// Any string in, a clean SortText out: unknown columns are dropped.
export const sortType = type("string").pipe((s) =>
	spellProductSort(parseProductSort(s)),
);

// Search chips as they travel through the URL and the database.
export const filtersType = type({
	field: type.enumerated(...FIELDS),
	value: "string",
	exclude: "boolean",
	and: "boolean",
	exact: "boolean",
}).array();

export type View = {
	id: number;
	name: string;
	filters: Filter[];
	sort: SortText;
};

// Same chips in the same order and the same sort.
export function sameSearch(
	a: { filters: Filter[]; sort: SortText },
	b: { filters: Filter[]; sort: SortText },
) {
	return (
		a.sort === b.sort &&
		a.filters.length === b.filters.length &&
		a.filters.every((f, i) => {
			const g = b.filters[i];
			return (
				f.field === g.field &&
				f.value === g.value &&
				f.exclude === g.exclude &&
				f.and === g.and
			);
		})
	);
}

// A link to products with one status chip, e.g. Home's "Oversold".
export function statusSearch(status: string, sort: ProductSort = []) {
	return {
		filters: [
			{
				field: "status",
				value: status,
				exclude: false,
				and: false,
				exact: true,
			},
		] satisfies Filter[],
		sort: spellProductSort(sort),
	};
}
