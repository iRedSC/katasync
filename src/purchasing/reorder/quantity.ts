import { afterArrival } from "#/inventory/stock-state";
import type { Forecast } from "#/purchasing/forecast";
import type { SetMembership } from "#/purchasing/sets";

// Reorder tops each product up to what it sold over the last cover days,
// less what's on the shelf and on order. That's the whole rule: no forecast
// of the lead time, no safety stock. Min stock and tool sets still set a
// floor under it.

const DAY_MS = 86_400_000;

export type Arrival = { units: number; arrivesAt: number | null };

// Units on order that land before the shelf runs out at `dailyDemand`, each
// one's arrival keeping the shelf going for the next. Undated and overdue
// ones don't count: nobody knows when they'll come.
export function timelyUnits(
	now: number,
	onHand: number,
	dailyDemand: number,
	arrivals: Arrival[],
) {
	const dated = arrivals
		.flatMap((a) =>
			a.arrivesAt === null || a.arrivesAt < now
				? []
				: [{ units: a.units, daysAway: (a.arrivesAt - now) / DAY_MS }],
		)
		.sort((a, b) => a.daysAway - b.daysAway);
	let shelf = Math.max(onHand, 0);
	let timely = 0;
	for (const { units, daysAway } of dated) {
		if (dailyDemand > 0 && daysAway * dailyDemand > shelf) continue;
		timely += units;
		shelf += units;
	}
	return timely;
}

// What reorder works from for one product. Sales, stock, what's on order,
// and minStock count the product itself; packSize is how many of it one of
// the supplier's units holds.
export type ReorderInput = {
	// Units sold over the last coverDays: what a reorder tops stock up to.
	recentSold: number;
	// Units a day while in stock (see Forecast), for when it will need
	// ordering. The quantity never reads it.
	dailyDemand: number;
	onHand: number;
	// Everything on open POs, however late.
	onOrder: number;
	coverDays: number;
	// The product's min stock: never let shelf plus on order drop below it.
	minStock: number;
	// Enough for one of each tool set it's in (see setFloorOf), or 0 in none:
	// below it, some set can't be sold. Holds like minStock.
	setFloor: number;
	minimumQuantity: number;
	packSize: number;
};

// Shelf plus on order. Oversold stock counts as 0, since receiving writes it
// off.
const position = (p: ReorderInput) => afterArrival(p.onHand, p.onOrder);

// Oversold with nothing on order: the shelf owes units nobody is bringing,
// so order at least one even with no recent sales or min stock.
function oversoldFloor(p: ReorderInput) {
	return p.onHand < 0 && p.onOrder === 0 ? 1 : 0;
}

// The least shelf plus on order may be: min stock, one of each of its tool
// sets if that's more, or the oversold floor.
const floorOf = (p: ReorderInput) =>
	Math.max(p.minStock, p.setFloor, oversoldFloor(p));

// What a reorder tops shelf plus on order up to: recent sales, or the floor
// if that's more.
const targetOf = (p: ReorderInput) => Math.max(p.recentSold, floorOf(p));

// Rounds a shortfall of single items up to whole supplier units and to at
// least the supplier's minimum. 0 when nothing's short.
function inUnits(p: ReorderInput, need: number) {
	if (need <= 0) return 0;
	return Math.max(Math.ceil(need / p.packSize), p.minimumQuantity);
}

// How many of the supplier's unit to order, or 0 to leave it off the PO.
export function reorderQuantity(p: ReorderInput): number {
	return inUnits(p, targetOf(p) - position(p));
}

// Days until a product that doesn't need ordering yet will, at its current
// sales. null when it never will (no sales) or already does.
export function daysUntilReorder(p: ReorderInput): number | null {
	const left = position(p) - targetOf(p);
	if (p.dailyDemand === 0 || left < 0) return null;
	return Math.floor(left / p.dailyDemand);
}

// The lowest default max, so slow sellers still keep a few on the shelf.
export const MIN_FORECAST_MAX = 5;

// The default max: what reorder tops stock up to from sales alone. At least
// MIN_FORECAST_MAX, and always above min.
export function forecastMax(min: number, recentSold: number) {
	return Math.max(min + 1, MIN_FORECAST_MAX, recentSold);
}

// How many of the supplier's unit fill stock up to max, rounded up to whole
// units and to at least the supplier's minimum. 0 when it's already there.
export function fillToMax(p: ReorderInput, max: number) {
	return inUnits(p, max - position(p));
}

// What reorder decided for one product, in the pieces a person can check.
export type ReorderWhy = {
	// Units a day while in stock, over inStockDays of the last DEMAND_DAYS.
	dailyDemand: number;
	inStockDays: number;
	// Share of selling products it outsells, 0 to 1. Null when it hasn't sold.
	rank: number | null;
	coverDays: number;
	// Units sold over coverDays, and how many of those days it sat sold out
	// (so `sold` reads low).
	recent: { sold: number; outDays: number };
	onHand: number;
	onOrder: number;
	// What a reorder tops shelf plus on order up to.
	aim:
		| { kind: "sales"; total: number }
		// The floor is more than recent sales, so it is the aim.
		| { kind: "min"; total: number; sales: number };
	// The least shelf plus on order may be, and where it comes from: the
	// product's min stock, one of each of its tool sets when that's more, or
	// one unit to restore oversold stock.
	minStock: number;
	minFrom: "stock" | "sets" | "oversold";
	// The tool sets it's a part of, and its shelf to build them from.
	sets: SetMembership;
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
		outDays: number;
		rank: number | null;
		purchase: ReorderWhy["purchase"];
		sets: SetMembership;
	},
): ReorderWhy {
	const floor = floorOf(p);
	const minFrom: ReorderWhy["minFrom"] =
		oversoldFloor(p) > Math.max(p.minStock, p.setFloor)
			? "oversold"
			: p.setFloor > p.minStock
				? "sets"
				: "stock";
	const aim: ReorderWhy["aim"] =
		floor > p.recentSold
			? { kind: "min", total: floor, sales: p.recentSold }
			: { kind: "sales", total: p.recentSold };
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
		coverDays: p.coverDays,
		recent: { sold: p.recentSold, outDays: context.outDays },
		onHand: p.onHand,
		onOrder: p.onOrder,
		aim,
		minStock: floor,
		minFrom,
		sets: context.sets,
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
