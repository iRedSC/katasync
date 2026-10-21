import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { groupPostage, postageLines } from "#/orders/postage-adjustments";
import {
	ordersNeedingCosts,
	ordersWaiting,
	profitByDay,
	profitByMarketplace,
	profitByProduct,
	profitItems,
	profitTotals,
	RANGES,
	type RangeKey,
	resolveRange,
} from "#/orders/profit";
import { updateProductDetails } from "#/products/details";

const rangeKeys = Object.keys(RANGES) as RangeKey[];
export const rangeType = type.enumerated(...rangeKeys);

export const getProfit = createServerFn({ method: "GET" })
	.validator(type({ range: rangeType }))
	.handler(async ({ data }) => {
		const db = getDb();
		const range = await resolveRange(db, data.range);
		const { start, end } = range;
		const [totals, previous, marketplaces, days, products, attention, waiting] =
			await Promise.all([
				profitTotals(db, start, end),
				profitTotals(db, range.previousStart, range.previousEnd),
				profitByMarketplace(db, start, end),
				profitByDay(db, start, end),
				profitByProduct(db, start, end),
				ordersNeedingCosts(db, start, end),
				ordersWaiting(db, start, end),
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
			waiting,
		};
	});

// Every item sold in the range, with what each made.
export const getProfitItems = createServerFn({ method: "GET" })
	.validator(type({ range: rangeType }))
	.handler(async ({ data }) => {
		const db = getDb();
		const range = await resolveRange(db, data.range);
		return { range, ...(await profitItems(db, range.start, range.end)) };
	});

// What carriers re-billed in the range, grouped by what was in the box and
// by product.
export const getPostageAdjustments = createServerFn({ method: "GET" })
	.validator(type({ range: rangeType }))
	.handler(async ({ data }) => {
		const db = getDb();
		const range = await resolveRange(db, data.range);
		return {
			range,
			...groupPostage(await postageLines(db, range.start, range.end)),
		};
	});

// Sets what one of a product costs. Sales already in with no cost of their
// own take it at once (order_line_costs); those with one keep theirs.
export const setProductCost = createServerFn({ method: "POST" })
	.validator(type({ productId: "number.integer > 0", unitCost: "number >= 0" }))
	.handler(async ({ data }) => {
		const saved = await updateProductDetails(getDb(), data.productId, {
			unitCost: data.unitCost,
		});
		return { sku: saved.sku, unitCost: saved.unitCost };
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
