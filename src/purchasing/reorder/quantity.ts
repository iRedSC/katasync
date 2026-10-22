import type { AbcClass } from "#/inventory/abc";
import { afterArrival } from "#/inventory/stock-state";
import { type Forecast, SERVICE_LEVELS } from "#/purchasing/forecast";
import type { SetMembership } from "#/purchasing/sets";

// What reorder works from for one product. Demand, stock, what's on order,
// and minStock count the product itself; packSize is how many of it one of
// the supplier's units holds.
export type ReorderInput = {
	dailyDemand: number;
	onHand: number;
	onOrder: number;
	leadTimeDays: number;
	safetyStock: number;
	coverDays: number;
	// The product's min stock: never let shelf plus on order drop below it.
	minStock: number;
	// Enough for one of each tool set it's in (see setFloorOf), or 0 in none:
	// below it, some set can't be sold. Holds like minStock.
	setFloor: number;
	minimumQuantity: number;
	packSize: number;
};

// Shelf plus on order, as it stands once what's ordered arrives. Oversold
// stock counts as 0, since receiving writes it off.
function position(p: ReorderInput) {
	return afterArrival(p.onHand, p.onOrder);
}

// Below this, a product needs ordering: what sells before a PO sent today
// arrives plus its safety stock, or its min stock if that's more.
function reorderPoint(p: ReorderInput) {
	return Math.max(p.dailyDemand * p.leadTimeDays + p.safetyStock, floorOf(p));
}

// Oversold with nothing on order: the shelf owes units nobody is bringing,
// so order at least one even with no recent sales or min stock.
function oversoldFloor(p: ReorderInput) {
	return p.onHand < 0 && p.onOrder === 0 ? 1 : 0;
}

// The least shelf plus on order may be: min stock, one of each of its tool
// sets if that's more, or the oversold floor.
const floorOf = (p: ReorderInput) =>
	Math.max(p.minStock, p.setFloor, oversoldFloor(p));

// How many of the supplier's unit it takes to top stock up to its target
// (stockTarget, or its floor if more), rounded up to whole units and to at
// least the supplier's minimum. 0 when it's already there.
function topUp(p: ReorderInput) {
	const need = Math.max(stockTarget(p), floorOf(p)) - position(p);
	if (need <= 0) return 0;
	return Math.max(Math.ceil(need / p.packSize), p.minimumQuantity);
}

// How many of the supplier's unit to order, or 0 to leave it off the PO: a
// top-up once shelf plus on order drops below the reorder point.
export function reorderQuantity(p: ReorderInput): number {
	return position(p) < reorderPoint(p) ? topUp(p) : 0;
}

// Days until a product that doesn't need ordering yet will, at its current
// sales. null when it never will (no sales) or already does.
export function daysUntilReorder(p: ReorderInput): number | null {
	const left = position(p) - reorderPoint(p);
	if (p.dailyDemand === 0 || left < 0) return null;
	return Math.floor(left / p.dailyDemand);
}

// What a reorder tops stock up to: enough to last until a PO sent today
// arrives and coverDays past it, plus safety stock. Also the default max.
export function stockTarget(p: {
	dailyDemand: number;
	leadTimeDays: number;
	safetyStock: number;
	coverDays: number;
}) {
	return Math.ceil(
		p.dailyDemand * (p.leadTimeDays + p.coverDays) + p.safetyStock,
	);
}

// The lowest default max, so slow sellers still keep a few on the shelf.
export const MIN_FORECAST_MAX = 5;

// The max a forecast gives: what reorder tops stock up to (see
// stockTarget). At least MIN_FORECAST_MAX, and always above min.
export function forecastMax(
	min: number,
	p: {
		dailyDemand: number;
		leadTimeDays: number;
		safetyStock: number;
		coverDays: number;
	},
) {
	return Math.max(min + 1, MIN_FORECAST_MAX, stockTarget(p));
}

// How many of the supplier's unit fill stock up to max, rounded up to whole
// units and to at least the supplier's minimum. 0 when it's already there.
export function fillToMax(p: ReorderInput, max: number) {
	const need = max - position(p);
	if (need <= 0) return 0;
	return Math.max(Math.ceil(need / p.packSize), p.minimumQuantity);
}

// What reorder decided for one product, in the pieces a person can check.
// The parts of `aim` add up to `aim.total` exactly, so a breakdown built from
// them never disagrees with the quantity.
export type ReorderWhy = {
	// Units a day while in stock, over inStockDays of the last DEMAND_DAYS.
	dailyDemand: number;
	inStockDays: number;
	// Share of selling products it outsells, 0 to 1. Null when it hasn't sold.
	rank: number | null;
	leadTime: {
		days: number;
		// measured: from the supplier's last `pos` deliveries. supplier: what
		// its settings say. default: no supplier, so DEFAULT_LEAD_TIME_DAYS.
		from: "measured" | "supplier" | "default";
		pos: number;
	};
	coverDays: number;
	abc: AbcClass | null;
	// How sure the safety stock makes us of not running out, 0 to 1.
	serviceShare: number;
	onHand: number;
	onOrder: number;
	// What a reorder tops shelf plus on order up to.
	aim:
		| {
				kind: "forecast";
				// Sold while a PO sent today is on its way.
				restock: number;
				safetyStock: number;
				// Sold over coverDays after it lands.
				cover: number;
				total: number;
		  }
		// The floor (minStock) is more than the forecast's aim, so it is the aim.
		| { kind: "min"; total: number; forecast: number };
	// The least shelf plus on order may be, and where it comes from: the
	// product's min stock, one of each of its tool sets when that's more, or
	// one unit to restore oversold stock.
	minStock: number;
	minFrom: "stock" | "sets" | "oversold";
	// The tool sets it's a part of, and its shelf to build them from.
	sets: SetMembership;
	// Reorder happens once shelf plus on order is below this.
	orderBelow: number;
	// What it's bought in. Null without a supplier: it can't be ordered yet.
	purchase: {
		unit: string;
		packSize: number;
		supplierCount: number;
		minimumQuantity: number;
	} | null;
	verdict:
		| {
				kind: "order";
				// In the supplier's unit; `units` counts the product.
				quantity: number;
				units: number;
				// Why units is more than the shortfall, if it is.
				roundedUp: "pack" | "minimum" | null;
		  }
		| { kind: "later"; days: number }
		// No sales and nothing below min: nothing will ever need ordering.
		| { kind: "idle" };
};

// Explains reorderQuantity's answer for `p` using the same functions, so the
// two can't drift apart.
export function explainReorder(
	p: ReorderInput,
	context: {
		inStockDays: number;
		rank: number | null;
		leadTime: ReorderWhy["leadTime"];
		abc: AbcClass | null;
		purchase: ReorderWhy["purchase"];
		sets: SetMembership;
	},
): ReorderWhy {
	const forecastAim = stockTarget(p);
	const floor = floorOf(p);
	const minFrom: ReorderWhy["minFrom"] =
		oversoldFloor(p) > Math.max(p.minStock, p.setFloor)
			? "oversold"
			: p.setFloor > p.minStock
				? "sets"
				: "stock";
	// Rounded the way reorderPoint compares: whole units under it reorder.
	const restock = Math.ceil(p.dailyDemand * p.leadTimeDays);
	const aim: ReorderWhy["aim"] =
		floor > forecastAim
			? { kind: "min", total: floor, forecast: forecastAim }
			: {
					kind: "forecast",
					restock,
					safetyStock: p.safetyStock,
					cover: forecastAim - restock - p.safetyStock,
					total: forecastAim,
				};
	const quantity = reorderQuantity(p);
	const days = daysUntilReorder(p);
	const shortfall = aim.total - position(p);
	const verdict: ReorderWhy["verdict"] =
		quantity > 0
			? {
					kind: "order",
					quantity,
					units: quantity * p.packSize,
					roundedUp:
						quantity === p.minimumQuantity &&
						p.minimumQuantity > Math.ceil(shortfall / p.packSize)
							? "minimum"
							: quantity * p.packSize > shortfall
								? "pack"
								: null,
				}
			: days === null
				? { kind: "idle" }
				: { kind: "later", days };
	return {
		dailyDemand: p.dailyDemand,
		inStockDays: context.inStockDays,
		rank: context.rank,
		leadTime: context.leadTime,
		coverDays: p.coverDays,
		abc: context.abc,
		serviceShare: SERVICE_LEVELS[context.abc ?? "C"].share,
		onHand: p.onHand,
		onOrder: p.onOrder,
		aim,
		minStock: floor,
		minFrom,
		sets: context.sets,
		orderBelow: Math.ceil(reorderPoint(p)),
		purchase: context.purchase,
		verdict,
	};
}

// Each selling product's share of selling products it outsells, 0 to 1:
// the fastest is 1, the slowest 0. Ties share the lower share.
export function velocityRanks(forecasts: Map<number, Forecast>) {
	const selling = [...forecasts]
		.filter(([, f]) => f.dailyDemand > 0)
		.sort(([, a], [, b]) => a.dailyDemand - b.dailyDemand);
	const ranks = new Map<number, number>();
	let below = 0;
	selling.forEach(([id, f], i) => {
		if (i > 0 && f.dailyDemand > selling[i - 1][1].dailyDemand) below = i;
		ranks.set(id, selling.length === 1 ? 1 : below / (selling.length - 1));
	});
	return ranks;
}
