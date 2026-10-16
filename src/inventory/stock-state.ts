import type { AbcClass } from "#/inventory/abc";
import type { StockRange } from "#/inventory/stock-range";

// What the products page says about a product's stock, worked out once here
// so a card's color, its label, the filter rail, and its button can't
// disagree.

// A shelf count older than this no longer vouches for the number.
export const TRUST_DAYS = 60;

// Whether the on-hand number can be acted on. A tool set's comes from its
// parts: the caller passes their oldest count.
export type Trust =
	| { kind: "counted"; at: Date }
	| { kind: "needs count"; requested: boolean };

// Most urgent first. Tool sets only ever get the first four.
export const LEVELS = [
	"oversold",
	"missing parts",
	"sold out",
	"below min",
	"healthy",
	"over max",
] as const;
export type Level = (typeof LEVELS)[number];

// The one thing to do next. Untrusted A and B stock gets counted before it's
// ordered: an order sized from a wrong number is wrong too, and those carry
// the money. C and unclassed products order on the number as it stands.
export type NextStep =
	| { kind: "order"; quantity: number; unit: string; packSize: number }
	| { kind: "count" }
	| { kind: "count requested" }
	| { kind: "on draft"; purchaseOrderId: number }
	| { kind: "set supplier" }
	| { kind: "none" };

export type StockInput = {
	kind: "simple" | "kit" | "bundle";
	abc: AbcClass | null;
	onHand: number | null;
	available: number;
	range: StockRange;
	// The oldest count across our shelves; null when any was never counted.
	lastCountedAt: Date | null;
	countRequested: boolean;
	hasSupplier: boolean;
	draft: { purchaseOrderId: number } | null;
	reorder: { quantity: number; unit: string; packSize: number } | null;
};

export function trustOf(p: StockInput, now: Date): Trust {
	const at = p.lastCountedAt;
	return at && now.getTime() - at.getTime() <= TRUST_DAYS * 86_400_000
		? { kind: "counted", at }
		: { kind: "needs count", requested: p.countRequested };
}

export function levelOf(p: StockInput): Level {
	const onHand = p.onHand ?? 0;
	if (onHand < 0) return "oversold";
	if (p.kind === "bundle")
		return p.available === 0 ? "missing parts" : "healthy";
	if (p.available === 0) return "sold out";
	if (onHand < p.range.min) return "below min";
	if (onHand > p.range.max) return "over max";
	return "healthy";
}

export function nextStepOf(p: StockInput, trust: Trust): NextStep {
	if (p.draft)
		return { kind: "on draft", purchaseOrderId: p.draft.purchaseOrderId };
	if (trust.kind === "needs count" && countsFirst(p.abc))
		return trust.requested ? { kind: "count requested" } : { kind: "count" };
	if (p.reorder) return { kind: "order", ...p.reorder };
	// Without a supplier nothing can suggest an order, so short stock asks
	// for one.
	if (
		!p.hasSupplier &&
		["oversold", "sold out", "below min"].includes(levelOf(p))
	)
		return { kind: "set supplier" };
	return { kind: "none" };
}

// Classes whose untrusted stock waits for a count before an order.
export const countsFirst = (abc: AbcClass | null) => abc === "A" || abc === "B";

// Days until on hand runs out at the recent sales rate. Null when nothing
// sold recently, so there's no rate to divide by.
export function daysLeft(onHand: number | null, dailyDemand: number) {
	if (onHand === null || dailyDemand <= 0) return null;
	return Math.max(0, Math.floor(onHand / dailyDemand));
}
