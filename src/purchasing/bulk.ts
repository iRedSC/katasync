import { perPack } from "./pack";

// Bulk prices: a supplier charging less per unit once an order reaches a
// quantity, e.g. $8 a case from 10 cases. On its own, without the database,
// so the browser shows the same prices the server charges. The database's
// bulk_price function (drizzle/0150) is priceAt, for the trigger that keeps
// draft lines on them.

export type PriceBreak = { minQuantity: number; cost: number };

// What a supplier sells a product at: its price per unit, null when it has
// none, and its bulk prices, fewest units first.
export type PriceList = { cost: number | null; breaks: PriceBreak[] };

// Within this share of a bulk price's quantity counts as close to it: 8 of
// 10 is close.
export const CLOSE_SHARE = 0.8;

// The price per unit for an order of `quantity`: the lowest of the price and
// every bulk price it reaches, so a stale bulk price above the price never
// costs more.
export function priceAt(list: PriceList, quantity: number): number | null {
	const reached = list.breaks
		.filter((b) => b.minQuantity <= quantity)
		.map((b) => b.cost);
	const all = list.cost === null ? reached : [list.cost, ...reached];
	return all.length === 0 ? null : Math.min(...all);
}

// The next bulk price cheaper than what the order pays now, and what
// reaching it means: `more` units, costing `extra` in total (negative when
// the bigger order costs less). Close when the order is most of the way
// there or the bigger order costs no more. Null when no bulk price beats it.
export type NextBreak = PriceBreak & {
	more: number;
	extra: number | null;
	close: boolean;
};

export function nextBreak(
	list: PriceList,
	quantity: number,
	paying: number | null,
): NextBreak | null {
	const now = paying ?? priceAt(list, quantity);
	const next = list.breaks
		.filter((b) => b.minQuantity > quantity && (now === null || b.cost < now))
		.sort((a, b) => a.minQuantity - b.minQuantity)[0];
	if (!next) return null;
	const extra =
		now === null ? null : round(next.minQuantity * next.cost - quantity * now);
	return {
		...next,
		more: next.minQuantity - quantity,
		extra,
		close:
			quantity >= next.minQuantity * CLOSE_SHARE ||
			(extra !== null && extra <= 0),
	};
}

// What's wrong with a set of bulk prices for a supplier selling at `cost`
// with a minimum order of `minimumQuantity`, or null when they're fine. Each
// must be for more than the minimum (or it's just the price), and cost less
// than the price and every bulk price for fewer.
export function breaksProblem(
	cost: number | null,
	minimumQuantity: number,
	breaks: PriceBreak[],
): string | null {
	const sorted = [...breaks].sort((a, b) => a.minQuantity - b.minQuantity);
	let below = cost;
	let before: number | null = null;
	for (const b of sorted) {
		if (!Number.isInteger(b.minQuantity) || b.minQuantity < 1)
			return `${b.minQuantity} isn't a whole number of units`;
		if (b.minQuantity <= Math.max(1, minimumQuantity))
			return `Every order is at least ${Math.max(1, minimumQuantity)}, so a bulk price from ${b.minQuantity} is just the price`;
		if (b.minQuantity === before)
			return `There are two bulk prices from ${b.minQuantity}`;
		if (!(Number.isFinite(b.cost) && b.cost >= 0))
			return `${b.cost} isn't a price`;
		if (below !== null && b.cost >= below)
			return `The price from ${b.minQuantity} must be under ${below}`;
		below = b.cost;
		before = b.minQuantity;
	}
	return null;
}

// Bulk prices in another pack size, meaning the same number of the product
// at the same price each: from 2 CASE of 30 is from 60 EACH. One that every
// order of `minimumQuantity` reaches in the new size is left out, since
// it's just the price there.
export function convertBreaks(
	breaks: PriceBreak[],
	fromPack: number,
	toPack: number,
	minimumQuantity: number,
): PriceBreak[] {
	const out = new Map<number, number>();
	for (const b of breaks) {
		const minQuantity = Math.ceil((b.minQuantity * fromPack) / toPack);
		if (minQuantity <= Math.max(1, minimumQuantity)) continue;
		const cost = perPack(b.cost, fromPack, toPack);
		const had = out.get(minQuantity);
		out.set(minQuantity, had === undefined ? cost : Math.min(had, cost));
	}
	return [...out]
		.map(([minQuantity, cost]) => ({ minQuantity, cost }))
		.sort((a, b) => a.minQuantity - b.minQuantity);
}

// A draft line's price once its quantity changes, as the database's trigger
// sets it: a line at the price for its quantity moves to the price for the
// new one; a price set by hand stays. So the page shows it before the save.
export function followPrice(
	list: PriceList | null,
	line: { quantity: number; unitCost: number | null },
	quantity: number,
) {
	if (list === null || line.unitCost !== priceAt(list, line.quantity))
		return line.unitCost;
	return priceAt(list, quantity);
}

const round = (n: number) => Math.round(n * 100) / 100;
