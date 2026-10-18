import type { Db } from "#/db/client";
import { type AbcResult, abcClasses } from "#/inventory/abc";
import {
	type Forecast,
	forecasts,
	type LeadTime,
	leadTimes,
	NO_FORECAST,
	safetyStock,
} from "#/purchasing/forecast";

// Everything reorder reads besides stock: each product's forecast, each
// supplier's lead time, and the classes that set how much safety stock to
// hold. Load it once and pass it around when several things need it.
export type Plan = {
	forecasts: Map<number, Forecast>;
	leadTimes: Map<number, LeadTime>;
	abc: AbcResult;
};

export async function loadPlan(
	db: Db,
	now = new Date(),
	abc?: AbcResult | Promise<AbcResult>,
): Promise<Plan> {
	const [f, l, a] = await Promise.all([
		forecasts(db, now),
		leadTimes(db),
		abc ?? abcClasses(db, now),
	]);
	return { forecasts: f, leadTimes: l, abc: a };
}

// A product's demand, lead time, and safety stock under a plan. Without a
// supplier it plans on the suppliers table's defaults.
export function planFor(
	plan: Plan,
	productId: number,
	supplierId: number | null,
) {
	const forecast = plan.forecasts.get(productId) ?? NO_FORECAST;
	const leadTimeDays =
		(supplierId === null ? undefined : plan.leadTimes.get(supplierId)?.days) ??
		DEFAULT_LEAD_TIME_DAYS;
	return {
		dailyDemand: forecast.dailyDemand,
		leadTimeDays,
		safetyStock: safetyStock(
			forecast,
			plan.abc.classes.get(productId)?.abc ?? null,
			leadTimeDays,
		),
	};
}

// What products without a supplier forecast with: the suppliers table's own
// defaults.
export const DEFAULT_LEAD_TIME_DAYS = 14;
export const DEFAULT_COVER_DAYS = 30;
