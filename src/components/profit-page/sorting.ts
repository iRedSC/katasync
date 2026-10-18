import { type Item, margin, other, shipping } from "./item";

export type SortKey =
	| "date"
	| "revenue"
	| "cost"
	| "fees"
	| "shipping"
	| "other"
	| "profit"
	| "margin";
export const SORT_VALUE: Record<SortKey, (i: Item) => number | null> = {
	date: (i) => new Date(i.placedAt).getTime(),
	revenue: (i) => i.revenue,
	cost: (i) => (i.costKnown ? i.cost : null),
	fees: (i) => i.fees,
	shipping,
	other,
	profit: (i) => i.profit,
	margin,
};
