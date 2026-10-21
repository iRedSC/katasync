import type { getProfitItems } from "#/server/profit";

export type Item = Awaited<ReturnType<typeof getProfitItems>>["items"][number];

export const margin = (i: Pick<Item, "profit" | "revenue">) =>
	i.revenue === 0 ? null : i.profit / i.revenue;
export const percent = (value: number | null) =>
	value === null ? "—" : `${(value * 100).toFixed(1)}%`;
// What the label cost, with any re-bill on it, less what the buyer paid for
// shipping.
export const shipping = (i: Item) =>
	i.labels + i.postageAdjustments - i.shippingCharged;
export const other = (i: Item) => i.refunds + i.adjustments;
