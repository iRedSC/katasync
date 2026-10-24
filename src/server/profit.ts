import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { stockValueByKind } from "#/inventory/stock-value";
import { parsePeriod } from "#/lib/period";
import {
	groupBoxes,
	groupPostage,
	postageBoxes,
	postageLines,
} from "#/orders/postage-adjustments";
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
	resolvePeriod,
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
		const [
			totals,
			previous,
			marketplaces,
			days,
			products,
			attention,
			waiting,
			stock,
		] = await Promise.all([
			profitTotals(db, start, end),
			profitTotals(db, range.previousStart, range.previousEnd),
			profitByMarketplace(db, start, end),
			profitByDay(db, start, end),
			profitByProduct(db, start, end),
			ordersNeedingCosts(db, start, end),
			ordersWaiting(db, start, end),
			stockValueByKind(db),
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
			stock,
		};
	});

// A named range or picked days, as lib/period.ts spells them. Checked here
// and parsed in the handler, so what crosses the wire stays a string.
const periodType = type("string").narrow(
	(text, ctx) =>
		parsePeriod(text) !== null ||
		ctx.mustBe("a range or days such as 2026-10-01..2026-10-15"),
);

// Every item sold in the period, with what each made.
export const getProfitItems = createServerFn({ method: "GET" })
	.validator(type({ period: periodType }))
	.handler(async ({ data }) => {
		const db = getDb();
		const period = parsePeriod(data.period);
		if (!period) throw new Error(`Not a period: ${data.period}`);
		const range = await resolvePeriod(db, period);
		return { range, ...(await profitItems(db, range.start, range.end)) };
	});

// What carriers re-billed in the range, grouped by what was in the box and
// by product.
export const getPostageAdjustments = createServerFn({ method: "GET" })
	.validator(type({ range: rangeType }))
	.handler(async ({ data }) => {
		const db = getDb();
		const range = await resolveRange(db, data.range);
		const [lines, boxes] = await Promise.all([
			postageLines(db, range.start, range.end),
			postageBoxes(db, range.start, range.end),
		]);
		return { range, ...groupPostage(lines), byBox: groupBoxes(boxes) };
	});

// Sets what one of a product costs. Sales already in with no cost of their
// own take it at once (src/inventory/valuation.ts); those with one keep theirs.
export const setProductCost = createServerFn({ method: "POST" })
	.validator(type({ productId: "number.integer > 0", unitCost: "number >= 0" }))
	.handler(async ({ data }) => {
		const saved = await updateProductDetails(getDb(), data.productId, {
			unitCost: data.unitCost,
		});
		return { sku: saved.sku, unitCost: saved.unitCost };
	});

// Saves how a product ships: its packed weight, and its box, all three sides
// or none. Fix postage sets these after a carrier re-bills.
export const setProductShipping = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			weightOz: "number > 0",
			box: ["number > 0", "number > 0", "number > 0"],
		}),
	)
	.handler(async ({ data }) => {
		const [lengthIn, widthIn, heightIn] = data.box;
		const saved = await updateProductDetails(getDb(), data.productId, {
			weightOz: data.weightOz,
			lengthIn,
			widthIn,
			heightIn,
		});
		return {
			weightGrams: saved.weightGrams,
			box:
				saved.lengthMm && saved.widthMm && saved.heightMm
					? ([saved.lengthMm, saved.widthMm, saved.heightMm] as [
							number,
							number,
							number,
						])
					: null,
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
