import { type } from "arktype";
import { FIELDS, type Filter } from "#/products/search";

// How the product list can be ordered. Only the sort button sets this; the
// search language has no way to type it.
export const SORTS = {
	name: "Name, A to Z",
	"-name": "Name, Z to A",
	inventory: "Inventory, lowest first",
	"-inventory": "Inventory, highest first",
	value: "Most valuable first",
	runout: "Runs out soonest",
} as const;
export type Sort = keyof typeof SORTS;

export const sortType = type.enumerated(...(Object.keys(SORTS) as Sort[]));

// Search chips as they travel through the URL and the database.
export const filtersType = type({
	field: type.enumerated(...FIELDS),
	value: "string",
	exclude: "boolean",
	and: "boolean",
	exact: "boolean",
}).array();

export type View = { id: number; name: string; filters: Filter[]; sort: Sort };

// Same chips in the same order and the same sort.
export function sameSearch(
	a: { filters: Filter[]; sort: Sort },
	b: { filters: Filter[]; sort: Sort },
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
export function statusSearch(status: string, sort: Sort = "name") {
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
		sort,
	};
}
