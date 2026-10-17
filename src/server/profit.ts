import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	ordersNeedingCosts,
	profitByDay,
	profitByMarketplace,
	profitByProduct,
	profitTotals,
	RANGES,
	type RangeKey,
	resolveRange,
} from "#/orders/profit";

const rangeKeys = Object.keys(RANGES) as RangeKey[];
export const rangeType = type.enumerated(...rangeKeys);

export const getProfit = createServerFn({ method: "GET" })
	.validator(type({ range: rangeType }))
	.handler(async ({ data }) => {
		const db = getDb();
		const range = await resolveRange(db, data.range);
		const { start, end } = range;
		const [totals, previous, marketplaces, days, products, attention] =
			await Promise.all([
				profitTotals(db, start, end),
				profitTotals(db, range.previousStart, range.previousEnd),
				profitByMarketplace(db, start, end),
				profitByDay(db, start, end),
				profitByProduct(db, start, end),
				ordersNeedingCosts(db, start, end),
			]);
		const ranked = [...products].sort((a, b) => b.profit - a.profit);
		return {
			range,
			totals,
			previous,
			marketplaces,
			days,
			best: ranked.slice(0, 10),
			// Products that lost money, worst first.
			worst: ranked
				.filter((p) => p.profit < 0)
				.reverse()
				.slice(0, 10),
			attention,
		};
	});

// This month's profit so far, for Home.
export const getMonthProfit = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const { start, end } = await resolveRange(db, "this_month");
		const totals = await profitTotals(db, start, end);
		return {
			profit: totals.profit,
			unsure: totals.orders - totals.complete,
		};
	},
);
