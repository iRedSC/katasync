import { DATE, NUMBER, type SortValue } from "#/products/sort";
import { type Item, margin, other, shipping } from "./item";

export const PROFIT_SORTS = {
	date: { label: "Date", ...DATE },
	revenue: { label: "Sales", ...NUMBER },
	cost: { label: "Cost", ...NUMBER },
	fees: { label: "Fees", ...NUMBER },
	shipping: { label: "Shipping", ...NUMBER },
	other: { label: "Refunds", ...NUMBER },
	profit: { label: "Contribution", ...NUMBER },
	margin: { label: "Margin", ...NUMBER },
} as const;
export type SortKey = keyof typeof PROFIT_SORTS;

export const sortValuesOf = (i: Item) =>
	({
		date: new Date(i.placedAt).getTime(),
		revenue: i.revenue,
		cost: i.costKnown ? i.cost : null,
		fees: i.fees,
		shipping: shipping(i),
		other: other(i),
		profit: i.profit,
		margin: margin(i),
	}) satisfies Record<SortKey, SortValue>;
